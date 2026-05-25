#!/usr/bin/env node
/**
 * scripts/generate-pwa-icons.mjs
 *
 * Genera los íconos de la PWA y el favicon de SALA a partir de UNA imagen
 * fuente. Pensado para usar UNA sola vez (o cuando se actualice el ícono de
 * marca), no en cada build.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  DÓNDE VA LA IMAGEN FUENTE
 * ────────────────────────────────────────────────────────────────────────────
 *  El script busca, en este orden:
 *    1) public/sala-icon-source.svg   ← preferido (vectorial)
 *    2) public/sala-icon-source.png   ← alternativa (cuadrado, ≥ 1024×1024)
 *
 *  La imagen tiene que ser CUADRADA. Idealmente con ~10-15% de padding interno
 *  para que no se recorte cuando se la enmascare como PWA "maskable" (la zona
 *  segura es el círculo central del ~80%).
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  SALIDA — todos en public/
 * ────────────────────────────────────────────────────────────────────────────
 *    icons/icon-192.png    192×192    PWA
 *    icons/icon-512.png    512×512    PWA + splash
 *    apple-touch-icon.png  180×180    iOS, OPACO (fondo verde primary)
 *    favicon.ico           16+32+48   multi-res, fallback browsers
 *    favicon.svg           copia 1:1 de la fuente — solo si la fuente es SVG
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  USO
 * ────────────────────────────────────────────────────────────────────────────
 *    1) Poner la imagen en  public/sala-icon-source.svg  (o .png).
 *    2) Instalar deps una sola vez:
 *         npm install --save-dev sharp png-to-ico
 *    3) Generar:
 *         node scripts/generate-pwa-icons.mjs
 *    4) Commit + push (los archivos generados van en public/).
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  DEPENDENCIAS
 * ────────────────────────────────────────────────────────────────────────────
 *    sharp        — resize de PNG/SVG → PNG
 *    png-to-ico   — empaqueta varios PNG en un .ico multi-resolución
 */

import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fondo verde de marca para TODOS los íconos: el SVG fuente es el símbolo
// BLANCO de SALA, que sobre fondo verde queda con look app-nativa (mismo
// patrón que la mayoría de apps modernas). Antes era blanco con símbolo
// verde — D-015 documentó la evolución cuando consigamos la versión blanca
// del logo. Ya la tenemos, así que actualizamos.
const BRAND_BG = '#3D6B52';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = resolve(ROOT, 'public');
const ICONS_DIR = resolve(PUBLIC_DIR, 'icons');

// 1) Localizar la imagen fuente
const candidates = ['sala-icon-source.svg', 'sala-icon-source.png'];
const sourcePath = candidates
  .map((name) => resolve(PUBLIC_DIR, name))
  .find((p) => existsSync(p));

if (!sourcePath) {
  console.error('No encontré la imagen fuente. Poné el logo de SALA en uno de:');
  for (const name of candidates) console.error('  public/' + name);
  process.exit(1);
}

const isSvg = sourcePath.endsWith('.svg');
console.log(`Fuente: ${sourcePath} ${isSvg ? '(SVG)' : '(PNG)'}\n`);

if (!existsSync(ICONS_DIR)) mkdirSync(ICONS_DIR, { recursive: true });

async function renderPng(outPath, size, { opaque = true, bg = BRAND_BG } = {}) {
  const pipeline = sharp(sourcePath).resize(size, size, {
    fit: 'contain',
    background: opaque ? bg : { r: 0, g: 0, b: 0, alpha: 0 }
  });
  if (opaque) pipeline.flatten({ background: bg });
  await pipeline.png().toFile(outPath);
  console.log(`  ✓ ${outPath}  (${size}×${size}${opaque ? `, opaco ${bg}` : ', alpha'})`);
}

// 2) PWA — opacos con fondo verde de marca. El SVG fuente trae el símbolo
//    blanco sobre transparencia; el flatten lo asienta sobre el verde
//    #3D6B52 para que el ícono tenga look app-nativa en Android (maskable)
//    y en cualquier launcher/escritorio.
await renderPng(resolve(ICONS_DIR, 'icon-192.png'), 192);
await renderPng(resolve(ICONS_DIR, 'icon-512.png'), 512);

// 3) apple-touch-icon — mismo verde. iOS no respeta transparencia; el
//    flatten lo aplica explícito así no queda un cuadrado negro en
//    versiones viejas.
await renderPng(resolve(PUBLIC_DIR, 'apple-touch-icon.png'), 180);

// 4) favicon.ico — multi-resolución. Mismo fondo verde que los demás para
//    que el ícono en pestaña del browser (cuando no soporta favicon.svg) se
//    vea coherente con el resto y siempre visible.
const tmpPngs = [];
for (const size of [16, 32, 48]) {
  const tmp = resolve(PUBLIC_DIR, `_tmp-favicon-${size}.png`);
  await sharp(sourcePath)
    .resize(size, size, { fit: 'contain', background: BRAND_BG })
    .flatten({ background: BRAND_BG })
    .png()
    .toFile(tmp);
  tmpPngs.push(tmp);
}
const icoBuffer = await pngToIco(tmpPngs);
writeFileSync(resolve(PUBLIC_DIR, 'favicon.ico'), icoBuffer);
console.log(`  ✓ ${resolve(PUBLIC_DIR, 'favicon.ico')}  (16/32/48 multi-res)`);
for (const p of tmpPngs) unlinkSync(p);

// 5) favicon.svg — el SVG principal (blanco) tiene símbolo blanco; en
//    pestaña de browser con fondo claro queda invisible. Por eso usamos
//    una fuente alternativa para el favicon: el símbolo VERDE sobre fondo
//    blanco, que se ve bien en pestañas con cualquier tema. Si no existe,
//    fallback a la fuente principal (que sería el blanco — los browsers
//    modernos van a fallback al .ico que sí tiene fondo verde sólido).
const faviconSource = resolve(PUBLIC_DIR, 'sala-favicon-source.svg');
const faviconSvgOut = resolve(PUBLIC_DIR, 'favicon.svg');
if (existsSync(faviconSource)) {
  copyFileSync(faviconSource, faviconSvgOut);
  console.log(`  ✓ ${faviconSvgOut}  (desde sala-favicon-source.svg)`);
} else if (isSvg) {
  copyFileSync(sourcePath, faviconSvgOut);
  console.log(`  ✓ ${faviconSvgOut}  (desde fuente principal — considerar agregar sala-favicon-source.svg si el símbolo es blanco)`);
} else {
  console.log(
    '  (favicon.svg no se genera: fuente PNG; el .ico cubre el fallback)'
  );
}

console.log('\nListo. Verificá public/icons/ y los archivos en public/. Commit + push.');
