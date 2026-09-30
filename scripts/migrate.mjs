// scripts/migrate.mjs
//
// Migra TODAS las imágenes de BookVault a este repo (servidas por
// raw.githubusercontent.com, que va por Fastly y no por Cloudflare -> sin bloqueo
// en partidos de LaLiga y sin depender de webs externas).
//
// Para cada fila cuya columna de imagen NO apunta ya a este repo:
//   1. descarga la imagen (R2, Supabase Storage, Open Library, Google Books, ISBNdb, blogs...)
//   2. descarta placeholders/rotas (ISBNdb 3736 bytes, < 1000 bytes, < 60 px):
//      esas se dejan tal cual para que clean-covers siga haciendo su trabajo
//   3. la convierte a WebP 350px calidad 75
//   4. la guarda en <prefijo>/<subcarpeta>/<id>.webp (máx. 1000 archivos por carpeta)
//   5. hace commit + push de la tanda
//   6. SOLO si el push ha ido bien, actualiza la columna en Supabase
//
// No borra nada en origen. Lo que quede huérfano en Supabase Storage se limpia
// con /api/telegram/clean-orphan-covers.
//
// Variables de entorno:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (secretos)
//   TARGETS     lista "tabla.columna" separada por comas (por defecto todas)
//   LIMIT       máximo de imágenes en esta ejecución (0 = sin límite)
//   DRY         "true" = descarga y convierte, pero no escribe nada
//   MAX_MINUTES corta la ejecución pasado este tiempo

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

const REPO_HOST = "raw.githubusercontent.com/paulamago-dot/bookvault-covers";
const RAW_BASE = `https://${REPO_HOST}/main`;
const WIDTH = 350;
const QUALITY = 75;
const PAGE = 200;               // filas por consulta = archivos por commit
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 20000;
const ISBNDB_PLACEHOLDER_SIZE = 3736;
const MIN_BYTES = 1000;
const MIN_PX = 60;

// Orden: primero lo pequeño. Los avatares de usuarios (profiles) NO se migran:
// el repo es público y son fotos personales.
const TARGETS = {
  "marta_books.cover_url":                 { prefix: "mrt" },
  "lecturalia_books.cover_url":            { prefix: "lec" },
  "delectoralector_books.cover_url":       { prefix: "dlr" },
  "marta_books.manual_cover_url":          { prefix: "mrt-m" },
  "lecturalia_books.manual_cover_url":     { prefix: "lec-m" },
  "delectoralector_books.manual_cover_url":{ prefix: "dlr-m" },
  "book_corrections.manual_cover_url":     { prefix: "corr" },
  "books.cover_url":                       { prefix: "gb" },
  "authors.photo_url":                     { prefix: "aut" },
  "telegram_books.cover_url":              { prefix: "tg" },
};

const env = process.env;
const DRY = env.DRY === "true";
const LIMIT = parseInt(env.LIMIT || "0", 10);
const MAX_MS = parseFloat(env.MAX_MINUTES || "300") * 60000;
const targets = (env.TARGETS || Object.keys(TARGETS).join(","))
  .split(",").map(s => s.trim()).filter(Boolean);

for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!env[k]) { console.error(`Falta el secreto ${k}`); process.exit(1); }
}
for (const t of targets) {
  if (!TARGETS[t]) { console.error(`Destino no permitido: ${t}`); process.exit(1); }
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const start = Date.now();
const stats = { procesadas: 0, subidas: 0, placeholders: 0, fallidas: 0, bytes_origen: 0, bytes_webp: 0 };
const porDestino = {};
const fallos = [];

const sh = (cmd) => execSync(cmd, { stdio: "inherit" });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class Placeholder extends Error {}

function folderFor(id) {
  const n = Number(id);
  if (Number.isInteger(n) && n >= 0) return String(Math.floor(n / 1000));
  return createHash("sha1").update(String(id)).digest("hex").slice(0, 2);
}

function fileId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, "_");
}

async function download(url) {
  for (let intento = 1; intento <= 2; intento++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
      });
      if (res.status === 429 && intento === 1) { await sleep(30000); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error("HTTP 429");
}

async function convert(row, column, prefix) {
  const url = row[column];
  const buf = await download(url);
  if (buf.length < MIN_BYTES) throw new Placeholder(`${buf.length} bytes`);
  if (url.includes("isbndb.com") && buf.length === ISBNDB_PLACEHOLDER_SIZE) throw new Placeholder("isbndb");
  const img = sharp(buf);
  const meta = await img.metadata();
  if ((meta.width || 0) < MIN_PX || (meta.height || 0) < MIN_PX) throw new Placeholder(`${meta.width}x${meta.height}`);
  const webp = await img
    .resize({ width: WIDTH, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toBuffer();
  const path = `${prefix}/${folderFor(row.id)}/${fileId(row.id)}.webp`;
  return { id: row.id, path, webp, origen: buf.length };
}

async function pool(items, fn, contarFallos = true) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try { out.push(await fn(item)); }
      catch (e) {
        if (e instanceof Placeholder) { stats.placeholders++; continue; }
        if (!contarFallos) throw e;
        stats.fallidas++;
        if (fallos.length < 30) fallos.push({ id: item.id, error: e.message, url: item.url });
      }
    }
  }));
  return out;
}

function pushBatch(target, prefix, n) {
  sh(`git add --sparse -A ${prefix}`);
  sh(`git -c user.name="bookvault-bot" -c user.email="bot@users.noreply.github.com" commit -q -m "${target}: +${n}"`);
  for (let intento = 1; intento <= 3; intento++) {
    try { sh("git push -q origin HEAD:main"); return; }
    catch (e) {
      if (intento === 3) throw e;
      sh("git pull -q --rebase origin main");
    }
  }
}

async function migrateTarget(target) {
  const [table, column] = target.split(".");
  const { prefix } = TARGETS[target];
  porDestino[target] = { subidas: 0 };
  let lastId = null;
  while (true) {
    if (Date.now() - start > MAX_MS) return "tiempo";
    if (LIMIT && stats.procesadas >= LIMIT) return "limite";

    const pageSize = LIMIT ? Math.min(PAGE, LIMIT - stats.procesadas) : PAGE;
    let q = supabase
      .from(table)
      .select(`id, ${column}`)
      .ilike(column, "http%")
      .not(column, "ilike", `%${REPO_HOST}%`)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (lastId !== null) q = q.gt("id", lastId);
    const { data: rows, error } = await q;
    if (error) throw new Error(`${target}: ${error.message}`);
    if (!rows.length) return "fin";
    lastId = rows[rows.length - 1].id;
    stats.procesadas += rows.length;

    const items = rows.map(r => ({ ...r, url: r[column] }));
    const ok = await pool(items, r => convert(r, column, prefix));
    for (const r of ok) { stats.bytes_origen += r.origen; stats.bytes_webp += r.webp.length; }
    if (DRY || !ok.length) continue;

    for (const r of ok) {
      mkdirSync(dirname(r.path), { recursive: true });
      writeFileSync(r.path, r.webp);
    }
    pushBatch(target, prefix, ok.length);

    // Push confirmado: ya se puede apuntar Supabase a GitHub
    await pool(ok, async r => {
      const { error: upErr } = await supabase
        .from(table).update({ [column]: `${RAW_BASE}/${r.path}` }).eq("id", r.id);
      if (upErr) throw new Error(`update: ${upErr.message}`);
      stats.subidas++;
      porDestino[target].subidas++;
    });
    console.log(`${target}: hasta id ${lastId} -> ${stats.subidas} subidas, ${stats.placeholders} placeholders, ${stats.fallidas} fallidas`);
  }
}

let motivo = "fin";
for (const t of targets) {
  motivo = await migrateTarget(t);
  if (motivo !== "fin") break;
}

const mb = b => (b / 1024 / 1024).toFixed(2);
const convertidas = stats.procesadas - stats.fallidas - stats.placeholders;
const resumen = {
  dry: DRY, motivo_parada: motivo, minutos: ((Date.now() - start) / 60000).toFixed(1),
  ...stats, mb_origen: mb(stats.bytes_origen), mb_webp: mb(stats.bytes_webp),
  kb_media_webp: convertidas > 0 ? (stats.bytes_webp / 1024 / convertidas).toFixed(1) : "0",
  por_destino: porDestino,
};
console.log(JSON.stringify(resumen, null, 2));
if (fallos.length) console.log("Muestra de fallos:", JSON.stringify(fallos, null, 2));
if (env.GITHUB_STEP_SUMMARY) {
  appendFileSync(env.GITHUB_STEP_SUMMARY,
    "## Migración de carátulas\n\n```json\n" + JSON.stringify(resumen, null, 2) + "\n```\n" +
    (fallos.length ? "\n### Fallos (muestra)\n\n```json\n" + JSON.stringify(fallos, null, 2) + "\n```\n" : ""));
}
