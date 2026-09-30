// scripts/migrate.mjs
//
// Migra carátulas de BookVault a este repo (servidas por raw.githubusercontent.com,
// que va por Fastly y no por Cloudflare -> sin bloqueo en partidos de LaLiga).
//
// Para cada libro cuya cover_url está en R2 o en Supabase Storage:
//   1. descarga la imagen
//   2. la convierte a WebP 350px calidad 75
//   3. la guarda en <prefijo>/<id/1000>/<id>.webp (máx. 1000 archivos por carpeta)
//   4. hace commit + push de la tanda
//   5. SOLO si el push ha ido bien, actualiza cover_url en Supabase
//
// No borra nada de R2 ni de Supabase Storage: las antiguas quedan huérfanas y
// se limpian después con /api/telegram/clean-orphan-covers.
//
// Variables de entorno:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, R2_PUBLIC_URL  (secretos)
//   TABLES      lista separada por comas (por defecto las 4)
//   LIMIT       máximo de carátulas en esta ejecución (0 = sin límite)
//   DRY         "true" = descarga y convierte, pero no escribe nada
//   MAX_MINUTES corta la ejecución pasado este tiempo

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

const RAW_BASE = "https://raw.githubusercontent.com/paulamago-dot/bookvault-covers/main";
const WIDTH = 350;
const QUALITY = 75;
const PAGE = 200;          // filas por consulta = archivos por commit
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 20000;

const TABLES = {
  telegram_books:        { prefix: "tg" },
  marta_books:           { prefix: "mrt" },
  lecturalia_books:      { prefix: "lec" },
  delectoralector_books: { prefix: "dlr" },
};

const env = process.env;
const DRY = env.DRY === "true";
const LIMIT = parseInt(env.LIMIT || "0", 10);
const MAX_MS = parseFloat(env.MAX_MINUTES || "300") * 60000;
const tables = (env.TABLES || Object.keys(TABLES).join(","))
  .split(",").map(s => s.trim()).filter(Boolean);

for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "R2_PUBLIC_URL"]) {
  if (!env[k]) { console.error(`Falta el secreto ${k}`); process.exit(1); }
}
for (const t of tables) {
  if (!TABLES[t]) { console.error(`Tabla no permitida: ${t}`); process.exit(1); }
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const R2_HOST = env.R2_PUBLIC_URL.replace(/^https?:\/\//, "").replace(/\/+$/, "");
const SB_STORAGE = "supabase.co/storage/v1/object/public/";

const start = Date.now();
const stats = { procesadas: 0, subidas: 0, fallidas: 0, bytes_origen: 0, bytes_webp: 0 };
const fallos = [];

const sh = (cmd) => execSync(cmd, { stdio: "inherit" });

async function download(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 BookVault-covers" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

async function convert(row, prefix) {
  const buf = await download(row.cover_url);
  const webp = await sharp(buf)
    .resize({ width: WIDTH, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toBuffer();
  const path = `${prefix}/${Math.floor(row.id / 1000)}/${row.id}.webp`;
  return { id: row.id, path, webp, origen: buf.length };
}

async function pool(items, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try { out.push(await fn(item)); }
      catch (e) {
        stats.fallidas++;
        if (fallos.length < 30) fallos.push({ id: item.id, url: item.cover_url, error: e.message });
      }
    }
  }));
  return out;
}

function pushBatch(table, n) {
  sh(`git add --sparse -A ${TABLES[table].prefix}`);
  sh(`git -c user.name="bookvault-bot" -c user.email="bot@users.noreply.github.com" commit -q -m "${table}: +${n} caratulas"`);
  for (let intento = 1; intento <= 3; intento++) {
    try { sh("git push -q origin HEAD:main"); return; }
    catch (e) {
      if (intento === 3) throw e;
      sh("git pull -q --rebase origin main");
    }
  }
}

async function migrateTable(table) {
  const { prefix } = TABLES[table];
  let lastId = 0;
  while (true) {
    if (Date.now() - start > MAX_MS) return "tiempo";
    if (LIMIT && stats.procesadas >= LIMIT) return "limite";

    const pageSize = LIMIT ? Math.min(PAGE, LIMIT - stats.procesadas) : PAGE;
    const { data: rows, error } = await supabase
      .from(table)
      .select("id, cover_url")
      .gt("id", lastId)
      .or(`cover_url.ilike.*${SB_STORAGE}*,cover_url.ilike.*${R2_HOST}*`)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!rows.length) return "fin";
    lastId = rows[rows.length - 1].id;
    stats.procesadas += rows.length;

    const ok = await pool(rows, r => convert(r, prefix));
    for (const r of ok) { stats.bytes_origen += r.origen; stats.bytes_webp += r.webp.length; }
    if (DRY || !ok.length) continue;

    for (const r of ok) {
      mkdirSync(dirname(r.path), { recursive: true });
      writeFileSync(r.path, r.webp);
    }
    pushBatch(table, ok.length);

    // Push confirmado: ya se puede apuntar Supabase a GitHub
    await pool(ok, async r => {
      const { error: upErr } = await supabase
        .from(table).update({ cover_url: `${RAW_BASE}/${r.path}` }).eq("id", r.id);
      if (upErr) throw new Error(`update: ${upErr.message}`);
      stats.subidas++;
    });
    console.log(`${table}: hasta id ${lastId} -> ${stats.subidas} subidas, ${stats.fallidas} fallidas`);
  }
}

let motivo = "fin";
for (const t of tables) {
  motivo = await migrateTable(t);
  if (motivo !== "fin") break;
}

const mb = b => (b / 1024 / 1024).toFixed(2);
const resumen = {
  dry: DRY, motivo_parada: motivo, minutos: ((Date.now() - start) / 60000).toFixed(1),
  ...stats, mb_origen: mb(stats.bytes_origen), mb_webp: mb(stats.bytes_webp),
  kb_media_webp: stats.procesadas - stats.fallidas > 0
    ? (stats.bytes_webp / 1024 / (stats.procesadas - stats.fallidas)).toFixed(1) : "0",
};
console.log(JSON.stringify(resumen, null, 2));
if (fallos.length) console.log("Muestra de fallos:", JSON.stringify(fallos, null, 2));
if (env.GITHUB_STEP_SUMMARY) {
  appendFileSync(env.GITHUB_STEP_SUMMARY,
    "## Migración de carátulas\n\n```json\n" + JSON.stringify(resumen, null, 2) + "\n```\n" +
    (fallos.length ? "\n### Fallos (muestra)\n\n```json\n" + JSON.stringify(fallos, null, 2) + "\n```\n" : ""));
}
