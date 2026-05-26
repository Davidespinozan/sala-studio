#!/usr/bin/env node
/**
 * Validador de regresión visual — Fase A del sistema de color dinámico.
 *
 * Computa cada derivado (-hover, -active, -light, -soft, -shadow, -dim,
 * -glow, -glow-strong, -focus-ring, -darkest) con SALA primary #3D6B52
 * y SALA accent #E8654A usando las fórmulas color-mix() de la Fase A,
 * y los compara contra los valores literales actuales en sala.css.
 *
 * Umbrales aceptados:
 *   - RGB Δ ≤ 5 unidades por canal (imperceptible)
 *   - Alpha Δ ≤ 3% (imperceptible)
 *
 * Además, hace sanity check con 3 primarios extremos (navy/amarillo/rojo)
 * para validar que las fórmulas se comportan razonablemente fuera de SALA.
 *
 * USO: node scripts/validate-color-regression.mjs
 *
 * SALIDA: tablas formateadas + veredicto final por bloque.
 */

// ============================================================================
// Bases
// ============================================================================

const SALA = {
  primary:     '#3D6B52',
  accent:      '#E8654A',
  bg:          '#FAFAF7',
  neutralDark: '#0A0F0C',
};

// ============================================================================
// Valores literales actuales en sala.css (lo que tenemos que matchear)
// ============================================================================

const LITERALS_PRIMARY = {
  hover:       '#2F5440',
  light:       '#E8F0EB',
  // Alphas: rgba(61, 107, 82, X) — el hex base es SALA.primary
  softAlpha:        0.12,
  shadowAlpha:      0.16,
  dimAlpha:         0.24,
  glowAlpha:        0.30,
  glowStrongAlpha:  0.42,   // promedio de 0.40 y 0.45 actuales
  focusRingAlpha:   0.55,
};

const LITERALS_ACCENT = {
  hover:        '#D54E33',
  light:        '#FCE8E2',
  softAlpha:    0.12,   // sintético (hoy no hay rgba accent-12 explícito)
  shadowAlpha:  0.16,
  dimAlpha:     0.24,
  glowAlpha:    0.30,
};

// ============================================================================
// Helpers de color
// ============================================================================

function hexToRgb(hex) {
  const cleaned = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(cleaned)) {
    throw new Error(`hexToRgb: invalid hex "${hex}"`);
  }
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  const c = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0').toUpperCase();
  return '#' + c(r) + c(g) + c(b);
}

function relativeLuminance(hex) {
  const rgb = hexToRgb(hex);
  const linearize = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
}

/** Texto sobre el color: blanco si oscuro, casi-negro si claro. Umbral 0.55. */
function pickTextOn(hex) {
  return relativeLuminance(hex) > 0.55 ? '#0A0A0A' : '#FFFFFF';
}

/** Dirección del hover: lighten si L<0.06 (ultra oscuro), darken si no. */
function pickHoverTint(hex) {
  return relativeLuminance(hex) < 0.06 ? '#FFFFFF' : '#000000';
}

/**
 * Equivalente a CSS `color-mix(in srgb, hexA pctA%, hexB)`.
 * pctA es el peso de A; B recibe (100 - pctA). Devuelve hex.
 */
function mix(hexA, pctA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const wa = pctA / 100;
  const wb = 1 - wa;
  return rgbToHex({
    r: a.r * wa + b.r * wb,
    g: a.g * wa + b.g * wb,
    b: a.b * wa + b.b * wb,
  });
}

/** Equivalente a `color-mix(in srgb, hex pct%, transparent)`. Devuelve rgba string. */
function alphaTint(hex, pct) {
  const rgb = hexToRgb(hex);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${(pct / 100).toFixed(2)})`;
}

// ============================================================================
// Derivados — fórmulas de la Fase A
// ============================================================================

function deriveAll(baseHex) {
  const tint = pickHoverTint(baseHex);
  const text = pickTextOn(baseHex);
  return {
    _luminance: relativeLuminance(baseHex),
    _tint: tint,
    _text: text,

    hover:      mix(baseHex, 78, tint),               // 22% tint
    active:     mix(baseHex, 68, tint),               // 32% tint
    light:      mix(baseHex, 10, SALA.bg),            // 10% sobre bg
    darkest:    mix(baseHex, 25, SALA.neutralDark),   // 25% sobre neutral-dark

    soft:       alphaTint(baseHex, 12),
    shadow:     alphaTint(baseHex, 16),
    dim:        alphaTint(baseHex, 24),
    glow:       alphaTint(baseHex, 30),
    glowStrong: alphaTint(baseHex, 42),
    focusRing:  alphaTint(baseHex, 55),
  };
}

// ============================================================================
// Comparación + thresholds
// ============================================================================

const RGB_THRESHOLD = 5;
const ALPHA_THRESHOLD_PCT = 3;

function rgbDelta(hexA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return { r: a.r - b.r, g: a.g - b.g, b: a.b - b.b };
}

function rgbDeltaMagnitude(d) {
  return Math.max(Math.abs(d.r), Math.abs(d.g), Math.abs(d.b));
}

function checkRgb(label, today, computed) {
  if (today === '(no existe)') return { label, today, computed, delta: '— nuevo', ok: null };
  const d = rgbDelta(computed, today);
  const mag = rgbDeltaMagnitude(d);
  const deltaStr = `(${d.r >= 0 ? '+' : ''}${d.r}, ${d.g >= 0 ? '+' : ''}${d.g}, ${d.b >= 0 ? '+' : ''}${d.b})`;
  return { label, today, computed, delta: deltaStr, magnitude: mag, ok: mag <= RGB_THRESHOLD };
}

function checkAlpha(label, todayAlpha, computedRgba, basePrimary) {
  const todayStr = alphaTint(basePrimary, todayAlpha * 100);
  const compAlpha = parseFloat(computedRgba.match(/, ?([0-9.]+)\)$/)[1]);
  const deltaPct = Math.abs(todayAlpha - compAlpha) * 100;
  return {
    label,
    today: todayStr,
    computed: computedRgba,
    delta: `Δα=${deltaPct.toFixed(1)}%`,
    magnitude: deltaPct,
    ok: deltaPct <= ALPHA_THRESHOLD_PCT,
  };
}

// ============================================================================
// Formato de tabla
// ============================================================================

function pad(s, n) { const str = String(s); return str + ' '.repeat(Math.max(0, n - str.length)); }

function printRows(rows) {
  console.log(pad('VAR', 16) + pad('HOY', 26) + pad('NUEVO', 26) + pad('Δ', 18) + 'STATUS');
  console.log('─'.repeat(90));
  for (const r of rows) {
    const status = r.ok === null ? '— nuevo' : (r.ok ? '✅' : '❌  EXCEDE UMBRAL');
    console.log(pad(r.label, 16) + pad(r.today, 26) + pad(r.computed, 26) + pad(r.delta, 18) + status);
  }
}

function summary(rows) {
  const meaningful = rows.filter(r => r.ok !== null);
  const failing = meaningful.filter(r => !r.ok);
  console.log();
  if (failing.length === 0) {
    console.log('✅ Regresión cero. Todos los Δ están dentro del umbral.');
  } else {
    console.log(`❌ ${failing.length}/${meaningful.length} derivados exceden el umbral.`);
    for (const f of failing) {
      console.log(`   - ${f.label}: ${f.delta}  (magnitud ${typeof f.magnitude === 'number' ? f.magnitude.toFixed(1) : f.magnitude})`);
    }
  }
}

// ============================================================================
// Bloques de salida
// ============================================================================

function header(title) {
  const bar = '═'.repeat(78);
  console.log();
  console.log('╔' + bar + '╗');
  console.log('║ ' + pad(title, 76) + '║');
  console.log('╚' + bar + '╝');
  console.log();
}

function runPrimary() {
  header('REGRESIÓN PRIMARY — SALA verde #3D6B52');
  const d = deriveAll(SALA.primary);
  console.log(`Luminance: ${d._luminance.toFixed(4)}    tint: ${d._tint === '#000000' ? 'black (darken)' : 'white (lighten)'}    text-on: ${d._text}`);
  console.log();

  const rows = [
    checkRgb('-hover',           LITERALS_PRIMARY.hover,    d.hover),
    checkRgb('-active',          '(no existe)',             d.active),
    checkRgb('-light',           LITERALS_PRIMARY.light,    d.light),
    checkRgb('-darkest',         '(no existe)',             d.darkest),
    checkAlpha('-soft',          LITERALS_PRIMARY.softAlpha,        d.soft,       SALA.primary),
    checkAlpha('-shadow',        LITERALS_PRIMARY.shadowAlpha,      d.shadow,     SALA.primary),
    checkAlpha('-dim',           LITERALS_PRIMARY.dimAlpha,         d.dim,        SALA.primary),
    checkAlpha('-glow',          LITERALS_PRIMARY.glowAlpha,        d.glow,       SALA.primary),
    checkAlpha('-glow-strong',   LITERALS_PRIMARY.glowStrongAlpha,  d.glowStrong, SALA.primary),
    checkAlpha('-focus-ring',    LITERALS_PRIMARY.focusRingAlpha,   d.focusRing,  SALA.primary),
  ];
  printRows(rows);
  summary(rows);
}

function runAccent() {
  header('REGRESIÓN ACCENT — SALA coral #E8654A');
  const d = deriveAll(SALA.accent);
  console.log(`Luminance: ${d._luminance.toFixed(4)}    tint: ${d._tint === '#000000' ? 'black (darken)' : 'white (lighten)'}    text-on: ${d._text}`);
  console.log();

  const rows = [
    checkRgb('-hover',     LITERALS_ACCENT.hover,    d.hover),
    checkRgb('-active',    '(no existe)',            d.active),
    checkRgb('-light',     LITERALS_ACCENT.light,    d.light),
    checkRgb('-darkest',   '(no existe)',            d.darkest),
    checkAlpha('-soft',    LITERALS_ACCENT.softAlpha,   d.soft,   SALA.accent),
    checkAlpha('-shadow',  LITERALS_ACCENT.shadowAlpha, d.shadow, SALA.accent),
    checkAlpha('-dim',     LITERALS_ACCENT.dimAlpha,    d.dim,    SALA.accent),
    checkAlpha('-glow',    LITERALS_ACCENT.glowAlpha,   d.glow,   SALA.accent),
  ];
  printRows(rows);
  summary(rows);
}

function runExtremes() {
  header('SANITY CHECK — primarios extremos (no regresión, validación de contrato)');

  const extremes = [
    { name: 'Navy ULTRA-OSCURO', hex: '#0A1628' },
    { name: 'Amarillo CLARO',    hex: '#F4D35E' },
    { name: 'Rojo SATURADO',     hex: '#E63946' },
  ];

  for (const ex of extremes) {
    const d = deriveAll(ex.hex);
    console.log(`▸ ${ex.name} (${ex.hex})`);
    console.log(`  L=${d._luminance.toFixed(3)}    tint=${d._tint === '#000000' ? 'black' : 'white'}    text=${d._text}`);
    console.log(`  -hover=${d.hover}    -active=${d.active}    -light=${d.light}    -darkest=${d.darkest}`);
    console.log();
  }
}

// ============================================================================
// Run
// ============================================================================

runPrimary();
runAccent();
runExtremes();

console.log();
console.log('─'.repeat(90));
console.log('LECTURA:');
console.log('  ✅ = dentro de umbral (RGB Δ≤5 / Alpha Δ≤3%) — regresión imperceptible');
console.log('  ❌ = excede umbral — revisar fórmula antes de refactorizar');
console.log('  — nuevo = derivado nuevo, sin valor anterior con qué comparar');
console.log();
