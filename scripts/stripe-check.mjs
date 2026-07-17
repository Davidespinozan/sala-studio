#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// DIAGNÓSTICO de la config de Stripe para SALA. SOLO LECTURA: no crea, no
// modifica y no borra nada. Contesta "¿qué falta?" sin adivinar.
//
// Chequea, contra lo que el código realmente necesita:
//   1. Los 9 precios del SaaS (lookup_key + que el monto coincida con el código).
//   2. Los 2 webhooks (URL, eventos, y si el de socios escucha Connected accounts).
//   3. El Customer Portal (si está configurado).
//
// USO:
//   STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-check.mjs
//   STRIPE_SECRET_KEY=sk_live_xxx node scripts/stripe-check.mjs
// ════════════════════════════════════════════════════════════════════════════

import Stripe from 'stripe';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');

const CICLO = 'mensual';
const MONEDAS = ['mxn', 'usd', 'eur'];
const TIERS = ['starter', 'pro', 'business'];

// La cuenta de Stripe está COMPARTIDA con otros productos (ekko/HSC). Sin esto,
// el chequeo agarraba el webhook viejo de ekkostudio.netlify.app —que también
// termina en /stripe-webhook— y reportaba un falso error sobre SALA.
// Override: HOST=otro-dominio.app node scripts/stripe-check.mjs
const HOST = process.env.HOST || 'salastudio.app';

// Lo que cada webhook necesita, según el código de las funciones.
// `eventos` = obligatorios. `alternativos` = grupos donde alcanza con UNO:
// el código trata invoice.paid e invoice.payment_succeeded en el mismo case,
// así que exigir los dos sería una falsa alarma.
const WEBHOOKS = [
  {
    nombre: 'SaaS (gym → SALA)',
    fn: 'stripe-webhook-saas',
    envSecret: 'STRIPE_WEBHOOK_SECRET_SAAS',
    connect: false,
    eventos: [
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.payment_failed'
    ],
    alternativos: [['invoice.paid', 'invoice.payment_succeeded']]
  },
  {
    nombre: 'Socios (socio → gym, Connect)',
    fn: 'stripe-webhook',
    envSecret: 'STRIPE_WEBHOOK_SECRET_SOCIO',
    connect: true,
    eventos: [
      'checkout.session.completed',
      'customer.subscription.deleted',
      'invoice.payment_failed',
      'account.updated'
    ],
    alternativos: [['invoice.paid', 'invoice.payment_succeeded']]
  }
];

const ok = (s) => `  ✔ ${s}`;
const falta = (s) => `  ✖ ${s}`;
const aviso = (s) => `  ⚠ ${s}`;

function leerPrecios() {
  const src = readFileSync(join(RAIZ, 'src/shared/lib/planesSaas.ts'), 'utf8');
  const precios = {};
  for (const tier of TIERS) {
    const bloque = new RegExp(`${tier}:\\s*\\{[\\s\\S]*?precios:\\s*\\{([^}]+)\\}`, 'm').exec(src);
    if (!bloque) continue;
    precios[tier] = {};
    for (const moneda of MONEDAS) {
      const m = new RegExp(`${moneda}:\\s*(\\d+)`).exec(bloque[1]);
      if (m) precios[tier][moneda] = Number(m[1]) * 100;
    }
  }
  return precios;
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('\n✖ Falta STRIPE_SECRET_KEY.\n  Uso: STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-check.mjs\n');
    process.exit(1);
  }
  const stripe = new Stripe(key);
  const modo = key.startsWith('sk_live_') ? 'LIVE' : 'TEST';
  console.log(`\n════ Diagnóstico Stripe · SALA · modo ${modo} ════\n`);

  let problemas = 0;

  // ── 1) Precios ────────────────────────────────────────────────────────────
  console.log('1. PRECIOS DEL SAAS');
  const precios = leerPrecios();
  for (const tier of TIERS) {
    for (const moneda of MONEDAS) {
      const lookupKey = `sala_${tier}_${moneda}_${CICLO}`;
      const esperado = precios[tier]?.[moneda];
      const res = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
      const p = res.data[0];
      if (!p) {
        console.log(falta(`${lookupKey} — NO existe`));
        problemas++;
      } else if (esperado != null && p.unit_amount !== esperado) {
        console.log(aviso(`${lookupKey} — monto Stripe ${p.unit_amount} ≠ código ${esperado}`));
        problemas++;
      } else {
        console.log(ok(`${lookupKey} — ${moneda.toUpperCase()} ${(p.unit_amount / 100).toLocaleString('es-MX')}`));
      }
    }
  }

  // ── 2) Webhooks ───────────────────────────────────────────────────────────
  console.log('\n2. WEBHOOKS');
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  if (endpoints.data.length === 0) {
    console.log(falta('No hay NINGÚN webhook en esta cuenta.'));
    problemas++;
  }
  for (const w of WEBHOOKS) {
    // Dos filtros: (1) que sea de NUESTRO host — la cuenta es compartida con
    // ekko/HSC y sus endpoints también terminan en /stripe-webhook; (2) que la
    // ruta termine exacto, porque 'stripe-webhook' matchea 'stripe-webhook-saas'.
    const exactos = endpoints.data.filter((e) => {
      if (!e.url) return false;
      const u = new URL(e.url);
      return u.hostname.endsWith(HOST) && u.pathname.endsWith(`/${w.fn}`);
    });
    console.log(`\n  ${w.nombre}`);
    if (exactos.length === 0) {
      console.log(falta(`No existe un endpoint que termine en /${w.fn}`));
      problemas++;
      continue;
    }
    for (const e of exactos) {
      console.log(ok(`Existe: ${e.url}  [${e.status}]`));
      const suyos = new Set(e.enabled_events);
      const todos = suyos.has('*');

      const faltantes = todos ? [] : w.eventos.filter((ev) => !suyos.has(ev));
      // Grupos "alcanza con uno": solo falla si NINGUNO está.
      const gruposVacios = todos
        ? []
        : (w.alternativos ?? []).filter((grupo) => !grupo.some((ev) => suyos.has(ev)));

      if (faltantes.length === 0 && gruposVacios.length === 0) {
        console.log(ok(`Tiene los eventos que el código necesita (${e.enabled_events.length} configurados)`));
      } else {
        if (faltantes.length) {
          console.log(falta(`Le faltan eventos: ${faltantes.join(', ')}`));
          problemas++;
        }
        for (const g of gruposVacios) {
          console.log(falta(`Le falta al menos uno de: ${g.join(' o ')}`));
          problemas++;
        }
      }
      console.log(`  ℹ Eventos actuales: ${todos ? '* (todos)' : e.enabled_events.join(', ')}`);

      // Connect: la API no siempre expone este flag de forma fiable. Si no se
      // puede leer, no lo damos por roto — se verifica de un vistazo en el
      // dashboard (columna "Cuentas conectadas" vs "Tu cuenta").
      if (w.connect) {
        if (e.connect === true) console.log(ok('Escucha Connected accounts'));
        else if (e.connect === false) {
          console.log(falta('NO escucha Connected accounts → los pagos de socios nunca llegarían.'));
          problemas++;
        } else {
          console.log(aviso('No pude leer el flag de Connect por API — verificá en el dashboard que diga "Cuentas conectadas".'));
        }
      }
      console.log(`  ℹ Su signing secret va en Netlify como ${w.envSecret}`);
    }
  }

  // ── 3) Customer Portal ────────────────────────────────────────────────────
  console.log('\n3. CUSTOMER PORTAL (para que el gym gestione/cancele su plan)');
  try {
    const cfgs = await stripe.billingPortal.configurations.list({ limit: 10 });
    const activa = cfgs.data.find((c) => c.active);
    if (activa) console.log(ok(`Configurado (${activa.id})`));
    else {
      console.log(falta('Sin configuración activa → portal-saas devolverá portal_no_configurado.'));
      problemas++;
    }
  } catch (e) {
    console.log(aviso(`No pude leerlo: ${e?.message ?? e}`));
  }

  console.log(
    problemas === 0
      ? '\n✔ Todo lo que el código necesita está configurado en Stripe.\n'
      : `\n▸ ${problemas} punto(s) a resolver (ver ✖ y ⚠ arriba).\n`
  );
}

main().catch((e) => {
  console.error('\n✖ Falló:', e?.message ?? e, '\n');
  process.exit(1);
});
