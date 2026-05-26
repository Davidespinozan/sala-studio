#!/usr/bin/env node
/**
 * Validador de contraste WCAG para Fase B Round 1 — sidebar dark.
 *
 * Para cada primario candidato, computa:
 *   1. El --sala-primary-darkest derivado (color-mix primary 25% + neutral-dark 75%).
 *   2. El contraste de texto blanco a varias opacidades sobre ese fondo.
 *   3. Verifica WCAG AA: 4.5:1 (texto chico) y 3:1 (texto grande/UI).
 *
 * Decide la opacidad mínima a usar para que TODOS los primarios pasen 4.5:1.
 *
 * USO: node scripts/validate-sidebar-contrast.mjs
 */

const NEUTRAL_DARK = '#0A0F0C';

const CANDIDATES = [
  { name: 'SALA verde',     hex: '#3D6B52' },
  { name: 'Navy oscuro',    hex: '#0A1628' },
  { name: 'Rojo saturado',  hex: '#E63946' },
  { name: 'Amarillo claro', hex: '#F4D35E' }
];

const OPACITIES_TO_TEST = [0.50, 0.55, 0.60, 0.65, 0.70, 0.80, 0.90, 1.00];

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

function rgbToHex({ r, g, b }) {
  const c = (n) => Math.round(n).toString(16).padStart(2, '0').toUpperCase();
  return '#' + c(r) + c(g) + c(b);
}

function relativeLuminance(rgb) {
  const linearize = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
}

function mix(rgbA, pctA, rgbB) {
  const wa = pctA / 100;
  const wb = 1 - wa;
  return {
    r: rgbA.r * wa + rgbB.r * wb,
    g: rgbA.g * wa + rgbB.g * wb,
    b: rgbA.b * wa + rgbB.b * wb
  };
}

function contrastRatio(rgbA, rgbB) {
  const la = relativeLuminance(rgbA);
  const lb = relativeLuminance(rgbB);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Color resultante de blanco con opacity sobre un bg sólido (alpha blending). */
function whiteOnDark(bg, opacity) {
  return mix({ r: 255, g: 255, b: 255 }, opacity * 100, bg);
}

function pad(s, n) { return String(s) + ' '.repeat(Math.max(0, n - String(s).length)); }

console.log('═'.repeat(85));
console.log('CONTRASTE WCAG — texto blanco a opacidad X sobre --sala-primary-darkest');
console.log('═'.repeat(85));
console.log();

const neutralRgb = hexToRgb(NEUTRAL_DARK);

for (const c of CANDIDATES) {
  const primaryRgb = hexToRgb(c.hex);
  const darkest = mix(primaryRgb, 25, neutralRgb);
  const darkestHex = rgbToHex(darkest);
  const darkestL = relativeLuminance(darkest);

  console.log(`▸ ${pad(c.name, 18)} (${c.hex})`);
  console.log(`  -darkest = ${darkestHex}    L=${darkestL.toFixed(4)}`);
  console.log();
  console.log('  ' + pad('Opacidad', 10) + pad('Color efectivo', 16) + pad('Contraste', 14) + 'WCAG AA texto (≥4.5)');
  console.log('  ' + '─'.repeat(70));

  for (const op of OPACITIES_TO_TEST) {
    const effective = whiteOnDark(darkest, op);
    const ratio = contrastRatio(effective, darkest);
    const passes = ratio >= 4.5;
    const passesUI = ratio >= 3;
    let status;
    if (passes) status = '✅ pasa texto';
    else if (passesUI) status = '⚠️  pasa UI solo (3:1)';
    else status = '❌ falla';
    console.log(
      '  ' +
      pad(op.toFixed(2), 10) +
      pad(rgbToHex(effective), 16) +
      pad(ratio.toFixed(2) + ':1', 14) +
      status
    );
  }
  console.log();
}

console.log('═'.repeat(85));
console.log('DECISIÓN DE OPACIDAD por uso (debe pasar 4.5:1 en TODOS los primarios)');
console.log('═'.repeat(85));
console.log();

const USE_CASES = [
  { name: 'Item nav inactivo',  minOpacity: 0.50, maxOpacity: 0.80 },
  { name: 'Section label',      minOpacity: 0.45, maxOpacity: 0.70 }
];

for (const uc of USE_CASES) {
  // Encontrar la opacidad mínima que pase 4.5:1 para TODOS los candidatos.
  let safeOpacity = null;
  for (let op = uc.minOpacity; op <= uc.maxOpacity + 0.001; op += 0.05) {
    const opR = Math.round(op * 100) / 100;
    let allPass = true;
    for (const c of CANDIDATES) {
      const primaryRgb = hexToRgb(c.hex);
      const darkest = mix(primaryRgb, 25, neutralRgb);
      const effective = whiteOnDark(darkest, opR);
      const ratio = contrastRatio(effective, darkest);
      if (ratio < 4.5) { allPass = false; break; }
    }
    if (allPass) { safeOpacity = opR; break; }
  }

  if (safeOpacity !== null) {
    console.log(`▸ ${pad(uc.name, 22)} → opacidad mínima segura: ${safeOpacity.toFixed(2)}`);
  } else {
    console.log(`▸ ${pad(uc.name, 22)} → ❌ NO HAY opacidad en rango ${uc.minOpacity}-${uc.maxOpacity} que pase 4.5:1 universal`);
  }
}
console.log();
