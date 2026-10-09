// scripts/reducir-avatares.mjs
//
// Reduce las fotos de perfil ya subidas al bucket "avatars" de Supabase.
// Las fotos se quedan en Supabase: NO se suben a este repo, que es público
// y son fotos personales.
//
// Para cada perfil cuyo avatar_url apunta al bucket "avatars" y pesa más de
// MIN_KB:
//   1. descarga la foto con la clave de servicio
//   2. la recorta en cuadrado centrado y la pasa a WebP 256 px, calidad 80
//   3. la sube como <user_id>/avatar_<timestamp>.webp (nombre nuevo, así
//      ninguna caché sirve la versión antigua)
//   4. SOLO si la subida ha ido bien, actualiza profiles.avatar_url
//
// No borra la foto antigua (se puede limpiar a mano más adelante).
//
// Variables de entorno:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (secretos)
//   DRY     "true" = descarga y convierte, pero no escribe nada
//   MIN_KB  solo se tocan fotos de más de estos KB (por defecto 100)

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const BUCKET = "avatars";
const LADO = 256;
const QUALITY = 80;

const env = process.env;
const DRY = env.DRY === "true";
const MIN_KB = Number(env.MIN_KB || 100);

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const MARCA = `/storage/v1/object/public/${BUCKET}/`;

const { data: perfiles, error } = await supabase
  .from("profiles")
  .select("id, nickname, avatar_url")
  .like("avatar_url", `%${MARCA}%`);

if (error) {
  console.error("Error leyendo profiles:", error.message);
  process.exit(1);
}

console.log(`${DRY ? "[SIMULACION] " : ""}Perfiles con avatar en Supabase: ${perfiles.length}`);

let reducidos = 0, saltados = 0, fallos = 0, ahorroKb = 0;

for (const p of perfiles) {
  const nombre = p.nickname || p.id;
  const ruta = decodeURIComponent(p.avatar_url.split(MARCA)[1].split("?")[0]);

  const { data: blob, error: errDesc } = await supabase.storage.from(BUCKET).download(ruta);
  if (errDesc || !blob) {
    console.log(`  ✗ ${nombre}: no se pudo descargar (${errDesc?.message})`);
    fallos++;
    continue;
  }

  const original = Buffer.from(await blob.arrayBuffer());
  const kbAntes = Math.round(original.length / 1024);
  if (kbAntes <= MIN_KB) {
    console.log(`  - ${nombre}: ${kbAntes} KB, se deja como está`);
    saltados++;
    continue;
  }

  let reducida;
  try {
    reducida = await sharp(original)
      .rotate() // respeta la orientación EXIF de las fotos del móvil
      .resize(LADO, LADO, { fit: "cover", position: "centre" })
      .webp({ quality: QUALITY })
      .toBuffer();
  } catch (e) {
    console.log(`  ✗ ${nombre}: no se pudo convertir (${e.message})`);
    fallos++;
    continue;
  }
  const kbDespues = Math.round(reducida.length / 1024);

  if (DRY) {
    console.log(`  ✓ ${nombre}: ${kbAntes} KB -> ${kbDespues} KB (simulación, no se escribe)`);
    reducidos++;
    ahorroKb += kbAntes - kbDespues;
    continue;
  }

  const nuevaRuta = `${p.id}/avatar_${Date.now()}.webp`;
  const { error: errSubida } = await supabase.storage.from(BUCKET).upload(nuevaRuta, reducida, {
    contentType: "image/webp",
    cacheControl: "31536000",
    upsert: false,
  });
  if (errSubida) {
    console.log(`  ✗ ${nombre}: error al subir (${errSubida.message})`);
    fallos++;
    continue;
  }

  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(nuevaRuta);
  const { error: errUpd } = await supabase.from("profiles").update({ avatar_url: publicUrl }).eq("id", p.id);
  if (errUpd) {
    console.log(`  ✗ ${nombre}: subida OK pero error al actualizar profiles (${errUpd.message})`);
    fallos++;
    continue;
  }

  console.log(`  ✓ ${nombre}: ${kbAntes} KB -> ${kbDespues} KB`);
  reducidos++;
  ahorroKb += kbAntes - kbDespues;
}

console.log(`\nReducidos: ${reducidos} · Sin tocar: ${saltados} · Fallos: ${fallos} · Ahorro por visualización: ${(ahorroKb / 1024).toFixed(1)} MB`);
if (fallos) process.exit(1);
