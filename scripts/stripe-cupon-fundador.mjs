#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// Crea el CUPÓN "fundador" y su CÓDIGO DE PROMOCIÓN en Stripe.
// ----------------------------------------------------------------------------
// QUÉ HACE: un cupón de $900 MXN de descuento, `duration: 'forever'`. Cuando el
// gym pone el código al pagar, Stripe le pega el cupón a la suscripción y se lo
// descuenta SOLO en cada factura mensual, para siempre. El cliente lo pone UNA
// vez, no todos los meses.
//
// EL NÚMERO: Starter cuesta $1,900. Menos $900 = $1,000/mes. Esto vale para
// Starter en pesos. Si un fundador estuviera en Pro ($3,900), el mismo cupón
// dejaría $3,000, no $1,000 — el descuento es un monto fijo, no un precio fijo.
// Como todos los gyms de hoy son Starter, funciona. Si algún día hay un trato
// de $1,000 sobre otro tier, se hace un cupón aparte.
//
// IDEMPOTENTE: el cupón tiene un id estable. Si ya existe, no crea otro. El
// código de promoción también se busca antes de crear.
//
// USO (la clave sale de tus env; NO la pegues en un chat):
//   STRIPE_SECRET_KEY=sk_live_xxx node scripts/stripe-cupon-fundador.mjs
//
//   Opcionales:
//     CODIGO=FUNDADOR        el texto que el gym escribe (default: FUNDADOR)
//     DESCUENTO_MXN=900      cuántos pesos descontar (default: 900)
// ════════════════════════════════════════════════════════════════════════════

import Stripe from 'stripe';

function morir(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const SK = process.env.STRIPE_SECRET_KEY;
if (!SK) morir('Falta STRIPE_SECRET_KEY');
if (SK.startsWith('sk_test_')) {
  console.warn('⚠  Clave de TEST: el cupón se crea en la cuenta de prueba, no en la real.\n');
}

const CODIGO = (process.env.CODIGO || 'FUNDADOR').toUpperCase();
const DESCUENTO_MXN = Number(process.env.DESCUENTO_MXN || 900);
if (!Number.isInteger(DESCUENTO_MXN) || DESCUENTO_MXN <= 0) morir('DESCUENTO_MXN inválido');

const stripe = new Stripe(SK, { apiVersion: '2024-06-20' });

// Id estable del cupón: así correr el script dos veces no crea dos cupones.
const CUPON_ID = `sala_fundador_${DESCUENTO_MXN}mxn`;

console.log(`\n▸ Cupón fundador — $${DESCUENTO_MXN} MXN off, para siempre\n`);

// ── 1. El cupón ─────────────────────────────────────────────────────────────
let cupon;
try {
  cupon = await stripe.coupons.retrieve(CUPON_ID);
  console.log(`  · cupón ${CUPON_ID} ya existía`);
} catch (e) {
  if (e?.code !== 'resource_missing') morir(`Leyendo el cupón: ${e.message}`);
  cupon = await stripe.coupons.create({
    id: CUPON_ID,
    amount_off: DESCUENTO_MXN * 100, // pesos → centavos
    currency: 'mxn',
    duration: 'forever', // ← esto es lo que lo auto-aplica cada mes
    name: `Fundador — $${DESCUENTO_MXN} off/mes`,
    metadata: { app: 'sala', deal: 'fundador' }
  });
  console.log(`  ✓ cupón ${CUPON_ID} creado`);
}

// ── 2. El código de promoción (lo que el gym escribe) ───────────────────────
const existentes = await stripe.promotionCodes.list({ code: CODIGO, limit: 1 });
if (existentes.data[0]) {
  const pc = existentes.data[0];
  const okCupon = pc.coupon?.id === CUPON_ID;
  console.log(`  · código ${CODIGO} ya existía${okCupon ? '' : '  ⚠ pero apunta a OTRO cupón: ' + pc.coupon?.id}`);
} else {
  const pc = await stripe.promotionCodes.create({
    coupon: cupon.id,
    code: CODIGO,
    // Sin tope: lo pueden usar todos los fundadores. Si querés limitarlo a X
    // gyms, agregá max_redemptions acá.
    metadata: { app: 'sala', deal: 'fundador' }
  });
  console.log(`  ✓ código ${CODIGO} creado (${pc.id})`);
}

console.log(`
─────────────────────────────────────────────
Listo. En el checkout, el gym escribe:  ${CODIGO}

  Starter $1,900  −  $${DESCUENTO_MXN}  =  $${(1900 - DESCUENTO_MXN).toLocaleString('es-MX')}/mes
  Se aplica solo, todos los meses, para siempre.
─────────────────────────────────────────────
`);