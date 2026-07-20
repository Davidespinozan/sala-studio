#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// Trae a `movimientos_dinero` las facturas del SaaS que ya cobró Stripe.
// ----------------------------------------------------------------------------
// POR QUÉ EXISTE: el webhook empieza a registrar los cobros a partir del día en
// que se despliega. Todo lo cobrado ANTES vive solo dentro de Stripe, así que
// el panel mostraría un negocio que factura casi nada. Este script recorre las
// facturas pagadas y las asienta en el libro.
//
// SEGURO DE CORRER VARIAS VECES: la idempotencia la da el índice único sobre
// (negocio, referencia_externa) — la referencia es el id de la factura. Un
// segundo pase no duplica nada; reporta cuántas ya estaban.
//
// SOLO CUENTA LO DE SALA: la cuenta de Stripe está COMPARTIDA con HSC. El
// filtro es el mismo que usa el webhook: el customer tiene que estar en
// `suscripciones_saas`. Sin ese filtro, los cobros del Club entrarían como
// ingreso de SALA.
//
// USO (ambas variables salen de tus env de Netlify; NO las pegues en un chat):
//   STRIPE_SECRET_KEY=sk_live_xxx \
//   SUPABASE_URL=https://omrlbvhbggnrwwzlgxji.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
//   node scripts/backfill-movimientos-saas.mjs
//
//   --dry   muestra lo que haría, sin escribir nada. Corrélo primero.
// ════════════════════════════════════════════════════════════════════════════

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const DRY = process.argv.includes('--dry');

function morir(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const SK = process.env.STRIPE_SECRET_KEY;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SK) morir('Falta STRIPE_SECRET_KEY');
if (!SB_URL || !SB_KEY) morir('Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY');
if (SK.startsWith('sk_test_')) {
  console.warn('⚠  Estás usando una clave de TEST. Las facturas serán de prueba.\n');
}

const stripe = new Stripe(SK, { apiVersion: '2024-06-20' });
const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// ── 1. Qué customers son de SALA ────────────────────────────────────────────
const { data: subs, error: errSubs } = await db
  .from('suscripciones_saas')
  .select('tenant_id, stripe_customer_id');
if (errSubs) morir(`No se pudo leer suscripciones_saas: ${errSubs.message}`);

const tenantDe = new Map();
for (const s of subs ?? []) {
  if (s.stripe_customer_id) tenantDe.set(s.stripe_customer_id, s.tenant_id);
}
if (tenantDe.size === 0) morir('Ningún tenant tiene stripe_customer_id. No hay nada que traer.');
console.log(`→ ${tenantDe.size} gyms con customer de Stripe.\n`);

// ── 2. Recorrer las facturas pagadas ────────────────────────────────────────
let vistas = 0;
let ajenas = 0;
let insertadas = 0;
let yaEstaban = 0;
// Por moneda, NUNCA en un solo total: los precios del SaaS son fijos por
// mercado, no convertidos. Sumar pesos con dolares da un numero inventado.
const totalPorMoneda = new Map();

for await (const inv of stripe.invoices.list({ status: 'paid', limit: 100 })) {
  vistas++;
  const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
  const tenantId = customerId ? tenantDe.get(customerId) : null;

  // No es de SALA (probablemente del Club, que comparte la cuenta).
  if (!tenantId) {
    ajenas++;
    continue;
  }

  const centavos = typeof inv.amount_paid === 'number' ? inv.amount_paid : 0;
  if (centavos <= 0) continue;

  // La fecha del cobro, no la de hoy: el ingreso pertenece al mes en que entró.
  const pagadoEn =
    typeof inv.status_transitions?.paid_at === 'number'
      ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
      : new Date(inv.created * 1000).toISOString();

  const fila = {
    negocio: 'sala',
    ocurrido_en: pagadoEn,
    monto_centavos: centavos,
    moneda: (inv.currency || 'mxn').toUpperCase(),
    concepto: 'suscripcion',
    metodo: 'stripe',
    referencia_externa: inv.id,
    tenant_id: tenantId,
    metadata: {
      backfill: true,
      numero_factura: inv.number ?? null,
      periodo_inicio: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
      periodo_fin: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null
    }
  };

  if (DRY) {
    console.log(
      `  [dry] ${pagadoEn.substring(0, 10)}  ${(centavos / 100).toFixed(2)} ${fila.moneda}  ${inv.id}`
    );
    insertadas++;
    totalPorMoneda.set(fila.moneda, (totalPorMoneda.get(fila.moneda) ?? 0) + centavos);
    continue;
  }

  const { error } = await db.from('movimientos_dinero').insert(fila);
  if (error) {
    // 23505 = ya estaba. Es lo esperado en un segundo pase, no un problema.
    if (error.code === '23505') {
      yaEstaban++;
      continue;
    }
    morir(`Insertando ${inv.id}: ${error.message}`);
  }
  insertadas++;
  totalPorMoneda.set(fila.moneda, (totalPorMoneda.get(fila.moneda) ?? 0) + centavos);
  console.log(
    `  ✓ ${pagadoEn.substring(0, 10)}  ${(centavos / 100).toFixed(2)} ${fila.moneda}  ${inv.id}`
  );
}

console.log(`
─────────────────────────────────────────────
Facturas pagadas en Stripe:  ${vistas}
  de otro negocio (ignoradas): ${ajenas}
  ya estaban en el libro:      ${yaEstaban}
  ${DRY ? 'se registrarían' : 'registradas'}:${' '.repeat(DRY ? 14 : 17)}${insertadas}

Total ${DRY ? 'a registrar' : 'registrado'}:
${[...totalPorMoneda].map(([m, c]) => `  ${(c / 100).toFixed(2)} ${m}`).join('\n') || '  (nada)'}
─────────────────────────────────────────────
${DRY ? '\nEsto fue un ensayo. Sacá --dry para escribir de verdad.' : ''}`);