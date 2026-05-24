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

const APPLE_BG = '#3D6B52'; // --sala-primary

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

async function renderPng(outPath, size, { opaque = false, bg = APPLE_BG } = {}) {
  const pipeline = sharp(sourcePath).resize(size, size, {
    fit: 'contain',
    background: opaque ? bg : { r: 0, g: 0, b: 0, alpha: 0 }
  });
  if (opaque) pipeline.flatten({ background: bg });
  await pipeline.png().toFile(outPath);
  console.log(`  ✓ ${outPath}  (${size}×${size}${opaque ? `, opaco ${bg}` : ', alpha'})`);
}

// 2) PWA — transparentes (los OS los componen sobre lo que sea)
await renderPng(resolve(ICONS_DIR, 'icon-192.png'), 192);
await renderPng(resolve(ICONS_DIR, 'icon-512.png'), 512);

// 3) apple-touch-icon — opaco (iOS no respeta transparencia; rellena con verde)
await renderPng(resolve(PUBLIC_DIR, 'apple-touch-icon.png'), 180, { opaque: true });

// 4) favicon.ico — multi-resolución
const tmpPngs = [];
for (const size of [16, 32, 48]) {
  const tmp = resolve(PUBLIC_DIR, `_tmp-favicon-${size}.png`);
  await sharp(sourcePath)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(tmp);
  tmpPngs.push(tmp);
}
const icoBuffer = await pngToIco(tmpPngs);
writeFileSync(resolve(PUBLIC_DIR, 'favicon.ico'), icoBuffer);
console.log(`  ✓ ${resolve(PUBLIC_DIR, 'favicon.ico')}  (16/32/48 multi-res)`);
for (const p of tmpPngs) unlinkSync(p);

// 5) favicon.svg — copia 1:1 si la fuente es SVG (browsers modernos lo prefieren)
if (isSvg) {
  copyFileSync(sourcePath, resolve(PUBLIC_DIR, 'favicon.svg'));
  console.log(`  ✓ ${resolve(PUBLIC_DIR, 'favicon.svg')}`);
} else {
  console.log(
    '  (favicon.svg no se genera: la fuente es PNG; el .ico cubre el fallback)'
  );
}

console.log('\nListo. Verificá public/icons/ y los archivos en public/. Commit + push.');
