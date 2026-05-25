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
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fondo verde de marca para TODOS los íconos: el SVG fuente es el símbolo
// BLANCO de SALA, que sobre fondo verde queda con look app-nativa (mismo
// patrón que la mayoría de apps modernas). Antes era blanco con símbolo
// verde — D-015 documentó la evolución cuando consigamos la versión blanca
// del logo. Ya la tenemos, así que actualizamos.
const BRAND_BG = '#3D6B52';

// Margen del símbolo dentro del lienzo. El SVG fuente trae poco padding
// propio — `fit: contain` solo lo escalaba para llenar el viewBox y el
// símbolo terminaba cerca de los bordes. Con PADDING_RATIO = 0.10, el
// símbolo ocupa el 80% del lienzo y queda con respiro visual coherente
// con la mayoría de íconos de apps. Si querés más/menos respiro, ajustar.
const PADDING_RATIO = 0.10;

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
  // Resize a (size - 2*pad) y luego extend con padding del color del fondo.
  // Eso le da al símbolo respiro visual desde los bordes del lienzo.
  const padPx = Math.round(size * PADDING_RATIO);
  const innerSize = size - padPx * 2;
  const transparentBg = { r: 0, g: 0, b: 0, alpha: 0 };

  const pipeline = sharp(sourcePath)
    .resize(innerSize, innerSize, {
      fit: 'contain',
      background: opaque ? bg : transparentBg
    })
    .extend({
      top: padPx, bottom: padPx, left: padPx, right: padPx,
      background: opaque ? bg : transparentBg
    });
  if (opaque) pipeline.flatten({ background: bg });
  await pipeline.png().toFile(outPath);
  console.log(`  ✓ ${outPath}  (${size}×${size}, símbolo ${innerSize}px${opaque ? `, opaco ${bg}` : ', alpha'})`);
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

// 4) favicon.ico — multi-resolución. Mismo fondo verde + padding que los
//    demás para que el ícono en pestaña del browser (cuando no soporta
//    favicon.svg) se vea coherente con el resto y con respiro visual.
const tmpPngs = [];
for (const size of [16, 32, 48]) {
  const tmp = resolve(PUBLIC_DIR, `_tmp-favicon-${size}.png`);
  // A 16/32px el padding del 10% es 2-3px — se reduce el detalle del
  // símbolo. Usamos el mismo helper para consistencia (el favicon en
  // pestaña suele verse a 16-20px de todas formas).
  await renderPng(tmp, size);
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
//
//    Al copiarlo, le agregamos PADDING_RATIO modificando el viewBox y
//    metiendo un <rect> blanco que cubra el viewBox extendido — sin esto
//    el SVG fuente trae el símbolo casi tocando los bordes y queda
//    inconsistente con los PNGs (que sí tienen margen).
const faviconSource = resolve(PUBLIC_DIR, 'sala-favicon-source.svg');
const faviconSvgOut = resolve(PUBLIC_DIR, 'favicon.svg');
const faviconSvgRawPath = existsSync(faviconSource) ? faviconSource : (isSvg ? sourcePath : null);
if (faviconSvgRawPath) {
  const raw = readFileSync(faviconSvgRawPath, 'utf8');
  const padded = addPaddingToSvg(raw, PADDING_RATIO);
  writeFileSync(faviconSvgOut, padded);
  console.log(`  ✓ ${faviconSvgOut}  (con padding ${(PADDING_RATIO * 100).toFixed(0)}%, desde ${faviconSvgRawPath.includes('favicon-source') ? 'sala-favicon-source.svg' : 'fuente principal'})`);
} else {
  console.log(
    '  (favicon.svg no se genera: fuente PNG; el .ico cubre el fallback)'
  );
}

/**
 * Inyecta padding alrededor del contenido de un SVG ampliando su viewBox
 * y agregando un <rect> blanco que cubre el nuevo viewBox. Asume que el
 * viewBox original es cuadrado o casi-cuadrado y empieza en (0, 0).
 */
function addPaddingToSvg(svgText, ratio) {
  const m = svgText.match(/viewBox="([0-9.\-eE]+)\s+([0-9.\-eE]+)\s+([0-9.\-eE]+)\s+([0-9.\-eE]+)"/);
  if (!m) {
    console.warn('  ⚠ no encontré viewBox para padding — copia 1:1');
    return svgText;
  }
  const [, minXStr, minYStr, wStr, hStr] = m;
  const minX = parseFloat(minXStr), minY = parseFloat(minYStr);
  const w = parseFloat(wStr), h = parseFloat(hStr);
  // Nuevo viewBox: contenido original a (1 - 2*ratio) del total.
  // total = original / (1 - 2*ratio); offset = (total - original) / 2
  const totalW = w / (1 - 2 * ratio);
  const totalH = h / (1 - 2 * ratio);
  const padW = (totalW - w) / 2;
  const padH = (totalH - h) / 2;
  const newMinX = minX - padW;
  const newMinY = minY - padH;
  const newViewBox = `${newMinX} ${newMinY} ${totalW} ${totalH}`;

  // Rect blanco que cubra el viewBox completo. Lo insertamos justo
  // después del primer ">" del tag <svg ...>.
  const bgRect = `<rect x="${newMinX}" y="${newMinY}" width="${totalW}" height="${totalH}" fill="#ffffff"/>`;
  return svgText
    .replace(/viewBox="[^"]+"/, `viewBox="${newViewBox}"`)
    .replace(/(<svg[^>]*>)/, `$1${bgRect}`);
}

console.log('\nListo. Verificá public/icons/ y los archivos en public/. Commit + push.');
