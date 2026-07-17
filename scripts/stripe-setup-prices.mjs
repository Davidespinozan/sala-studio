#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// Crea (o verifica) los Products + Prices del SaaS de SALA en Stripe.
// ----------------------------------------------------------------------------
// POR QUÉ EXISTE: el backend resuelve el precio por `lookup_key`, nunca por
// price_id (los ids no sobreviven test→live; los lookup_keys sí). Un typo en un
// lookup_key hecho a mano en el dashboard NO se nota hasta que un gym intenta
// pagar y el checkout tira "No hay price activo". Este script los genera con el
// mismo formato que arma el backend, así que no puede haber typo.
//
// NO HARDCODEA MONTOS: los lee de src/shared/lib/planesSaas.ts (la fuente de
// verdad comercial). Si mañana cambiás un precio ahí, corré esto de nuevo.
//
// USO:
//   STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-setup-prices.mjs
//   STRIPE_SECRET_KEY=sk_live_xxx node scripts/stripe-setup-prices.mjs --live
//
// Es IDEMPOTENTE: si el price del lookup_key ya existe, no lo toca. Podés
// correrlo las veces que quieras.
// ════════════════════════════════════════════════════════════════════════════

import Stripe from 'stripe';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');

// El backend solo vende el ciclo mensual hoy (suscribir-saas usa 'mensual' por
// default y el front no ofrece anual). Si algún día se vende anual, agregar acá.
const CICLO = 'mensual';
const MONEDAS = ['mxn', 'usd', 'eur'];
const TIERS = ['starter', 'pro', 'business'];

const NOMBRE_TIER = { starter: 'Starter', pro: 'Pro', business: 'Business' };

function morir(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

// ── 1) Validar que el formato del lookup_key sigue siendo el que arma el backend
function validarFormatoLookupKey() {
  const src = readFileSync(join(RAIZ, 'netlify/functions/_lib/saasBilling.ts'), 'utf8');
  if (!src.includes('`sala_${tier}_${moneda}_${ciclo}`')) {
    morir(
      'El formato del lookup_key en saasBilling.ts cambió y este script quedó viejo.\n' +
      '  Revisá lookupKeyFor() y actualizá este archivo antes de crear precios.'
    );
  }
}

// ── 2) Leer los montos de la fuente de verdad (planesSaas.ts)
function leerPrecios() {
  const src = readFileSync(join(RAIZ, 'src/shared/lib/planesSaas.ts'), 'utf8');
  const precios = {};
  for (const tier of TIERS) {
    // Busca el bloque del tier y adentro su línea `precios: { mxn: N, usd: N, eur: N }`
    const bloque = new RegExp(
      `${tier}:\\s*\\{[\\s\\S]*?precios:\\s*\\{([^}]+)\\}`,
      'm'
    ).exec(src);
    if (!bloque) morir(`No pude leer los precios de "${tier}" en planesSaas.ts.`);
    const cuerpo = bloque[1];
    precios[tier] = {};
    for (const moneda of MONEDAS) {
      const m = new RegExp(`${moneda}:\\s*(\\d+)`).exec(cuerpo);
      if (!m) morir(`Falta el precio ${moneda.toUpperCase()} de "${tier}" en planesSaas.ts.`);
      // planesSaas guarda la unidad principal (1900 = $1,900) y precioCentavos
      // hace ×100. Stripe pide la unidad MÍNIMA → mismo ×100.
      precios[tier][moneda] = Number(m[1]) * 100;
    }
  }
  return precios;
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    morir(
      'Falta STRIPE_SECRET_KEY.\n' +
      '  Uso: STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-setup-prices.mjs'
    );
  }

  const esLive = key.startsWith('sk_live_');
  if (esLive && !process.argv.includes('--live')) {
    morir(
      'Esa es una clave LIVE (dinero real) y no pasaste --live.\n' +
      '  Si es a propósito:  ... node scripts/stripe-setup-prices.mjs --live'
    );
  }

  validarFormatoLookupKey();
  const precios = leerPrecios();

  const stripe = new Stripe(key);
  const modo = esLive ? 'LIVE (dinero real)' : 'TEST';
  console.log(`\n▸ Modo: ${modo}`);
  console.log(`▸ Creando ${TIERS.length * MONEDAS.length} precios (${TIERS.length} planes × ${MONEDAS.length} monedas), ciclo ${CICLO}.\n`);

  let creados = 0;
  let existentes = 0;

  for (const tier of TIERS) {
    // El producto se crea PEREZOSAMENTE: solo si de verdad hay que crear algún
    // price. Si los prices ya existen (aunque cuelguen de otro producto viejo),
    // no tocamos nada — antes esto dejaba productos vacíos de basura.
    const productId = `sala_${tier}`;
    let productoId = null;
    const obtenerProducto = async () => {
      if (productoId) return productoId;
      try {
        const p = await stripe.products.retrieve(productId);
        productoId = p.id;
      } catch {
        const p = await stripe.products.create({
          id: productId,
          name: `SALA ${NOMBRE_TIER[tier]}`,
          metadata: { app: 'sala', tier }
        });
        console.log(`  + Producto creado: ${p.id}`);
        productoId = p.id;
      }
      return productoId;
    };

    for (const moneda of MONEDAS) {
      const lookupKey = `sala_${tier}_${moneda}_${CICLO}`;
      const montoMin = precios[tier][moneda];

      // ¿Ya hay un price con ese lookup_key? (incluye inactivos: si existe uno
      // inactivo, crear otro con la misma key falla — hay que avisar, no romper.)
      const yaActivos = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
      if (yaActivos.data[0]) {
        const p = yaActivos.data[0];
        const coincide = p.unit_amount === montoMin && p.currency === moneda;
        console.log(
          `  = ${lookupKey.padEnd(30)} ya existe (${p.id})` +
          (coincide ? '' : `  ⚠ MONTO DISTINTO: Stripe ${p.unit_amount} vs código ${montoMin}`)
        );
        existentes++;
        continue;
      }

      const price = await stripe.prices.create({
        product: await obtenerProducto(),
        currency: moneda,
        unit_amount: montoMin,
        recurring: { interval: 'month' },
        lookup_key: lookupKey,
        transfer_lookup_key: true, // si había uno inactivo con esa key, la toma
        metadata: { app: 'sala', tier, moneda, ciclo: CICLO }
      });
      const legible = (montoMin / 100).toLocaleString('es-MX');
      console.log(`  + ${lookupKey.padEnd(30)} creado (${price.id})  ${moneda.toUpperCase()} ${legible}`);
      creados++;
    }
  }

  console.log(`\n✔ Listo. ${creados} creado(s), ${existentes} ya existía(n).`);
  if (!esLive) {
    console.log('  Esto fue en TEST. Cuando valides el circuito, repetí con la clave live y --live.\n');
  } else {
    console.log('');
  }
}

main().catch((e) => {
  console.error('\n✖ Falló:', e?.message ?? e, '\n');
  process.exit(1);
});
