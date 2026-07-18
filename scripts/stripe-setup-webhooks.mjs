#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// Crea (o verifica) los 2 webhooks de Stripe que usa SALA.
// ----------------------------------------------------------------------------
// POR QUÉ EXISTE: crear webhooks a mano en el dashboard es propenso a errores
// (URL mal tipeada, faltó un evento, o olvidarse de marcar "Connected accounts"
// en el de socios → los pagos caen y nadie se entera). Este script los crea con
// la URL, los eventos y el flag connect exactos que espera el backend.
//
// LOS EVENTOS NO SE HARDCODEAN A CIEGAS: son los mismos `case '...'` que manejan
// las functions (ver abajo). Si agregás un case nuevo, agregá el evento acá.
//
// USO:
//   STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-setup-webhooks.mjs
//   STRIPE_SECRET_KEY=sk_live_xxx node scripts/stripe-setup-webhooks.mjs --live
//   (opcional) --host=salastudio.app   para otro dominio
//
// IDEMPOTENTE: si ya existe un endpoint con esa misma URL, NO crea otro. Ojo:
// Stripe solo devuelve el signing secret (whsec_) al CREARLO. Si ya existía, el
// script te avisa y te dice cómo obtener el secret (Reveal en el dashboard, o
// borrar y volver a correr).
// ════════════════════════════════════════════════════════════════════════════

import Stripe from 'stripe';

function morir(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

// Los 2 webhooks. `connect: true` = escucha eventos de las CUENTAS CONECTADAS
// (los gyms); `connect: false` = eventos de TU cuenta (el SaaS).
function definirWebhooks(host) {
  return [
    {
      nombre: 'SaaS (pagos de los gyms a SALA)',
      path: '/.netlify/functions/stripe-webhook-saas',
      connect: false,
      envVar: 'STRIPE_WEBHOOK_SECRET_SAAS',
      // = case '...' de stripe-webhook-saas/index.ts
      events: [
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'invoice.paid',
        'invoice.payment_failed',
        'invoice.payment_succeeded'
      ]
    },
    {
      nombre: 'Connect (pagos de los socios a los gyms)',
      path: '/.netlify/functions/stripe-webhook',
      connect: true,
      envVar: 'STRIPE_WEBHOOK_SECRET_SOCIO',
      // = case '...' de stripe-webhook/index.ts
      events: [
        'account.updated',
        'checkout.session.completed',
        'customer.subscription.deleted',
        'invoice.paid',
        'invoice.payment_failed',
        'invoice.payment_succeeded'
      ]
    }
  ].map((w) => ({ ...w, url: `https://${host}${w.path}` }));
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    morir(
      'Falta STRIPE_SECRET_KEY.\n' +
      '  Uso: STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-setup-webhooks.mjs'
    );
  }

  const esLive = key.startsWith('sk_live_');
  if (esLive && !process.argv.includes('--live')) {
    morir(
      'Esa es una clave LIVE (dinero real) y no pasaste --live.\n' +
      '  Si es a propósito:  ... node scripts/stripe-setup-webhooks.mjs --live'
    );
  }

  const hostArg = process.argv.find((a) => a.startsWith('--host='));
  // CON www. El apex (salastudio.app) responde 308 hacia www, y Stripe NO sigue
  // redirecciones: el evento se pierde en el 308 y la suscripción del gym nunca
  // se actualiza — sin ningún error visible. Ya nos costó que ningún pago se
  // registrara. La verificación de abajo es la red de seguridad.
  const host = hostArg ? hostArg.slice('--host='.length) : 'www.salastudio.app';

  const stripe = new Stripe(key);
  const webhooks = definirWebhooks(host);
  const modo = esLive ? 'LIVE (dinero real)' : 'TEST';
  console.log(`\n▸ Modo: ${modo}`);
  console.log(`▸ Host: ${host}\n`);

  // Traemos los endpoints que ya existen para no duplicar.
  const existentes = [];
  for await (const ep of stripe.webhookEndpoints.list({ limit: 100 })) existentes.push(ep);

  const secretos = []; // { envVar, secret|null, url, yaExistia }

  // ── Red de seguridad: la URL tiene que responder DIRECTO, sin redirección.
  // Stripe no sigue 3xx; un endpoint que redirige acepta la creación igual y
  // después descarta todos los eventos en silencio.
  for (const w of webhooks) {
    let estado;
    try {
      const r = await fetch(w.url, { method: 'POST', redirect: 'manual' });
      estado = r.status;
    } catch (e) {
      morir(`No pude alcanzar ${w.url}\n  ${e?.message ?? e}`);
    }
    if (estado >= 300 && estado < 400) {
      morir(
        `${w.url} responde ${estado} (REDIRECCIÓN).\n` +
        '  Stripe no sigue redirecciones: los eventos se perderían en silencio.\n' +
        '  Usá el host definitivo (probá con/sin "www"):  --host=www.tu-dominio.com'
      );
    }
    if (estado === 404) {
      morir(`${w.url} responde 404: esa función no existe o no está deployada.`);
    }
    console.log(`  ✓ ${w.url} responde ${estado} (sin redirección)`);
  }
  console.log('');

  for (const w of webhooks) {
    const previo = existentes.find((e) => e.url === w.url);
    if (previo) {
      console.log(`  = ${w.nombre}`);
      console.log(`    ${w.url}`);
      console.log(`    Ya existe (${previo.id}). El secret NO se puede leer por API una vez creado.`);
      secretos.push({ envVar: w.envVar, secret: null, url: w.url, yaExistia: true });
      continue;
    }

    const ep = await stripe.webhookEndpoints.create({
      url: w.url,
      enabled_events: w.events,
      connect: w.connect,
      description: `SALA — ${w.nombre}`,
      metadata: { app: 'sala' }
    });
    console.log(`  + ${w.nombre}`);
    console.log(`    ${w.url}`);
    console.log(`    Creado (${ep.id})  ${w.connect ? '[Connected accounts]' : '[Tu cuenta]'}  ${w.events.length} eventos`);
    secretos.push({ envVar: w.envVar, secret: ep.secret, url: w.url, yaExistia: false });
  }

  // ── Resumen: qué poner en Netlify.
  console.log('\n──────────────────────────────────────────────────────────');
  console.log(' VARIABLES PARA NETLIFY (Site settings → Environment variables)');
  console.log('──────────────────────────────────────────────────────────');
  for (const s of secretos) {
    if (s.secret) {
      console.log(`  ${s.envVar} = ${s.secret}`);
    } else {
      console.log(`  ${s.envVar} = (ya existía — abrí el webhook en el dashboard →`);
      console.log(`                 "Signing secret" → Reveal, o borralo y volvé a correr esto)`);
    }
  }
  console.log('──────────────────────────────────────────────────────────');
  if (esLive) {
    console.log(' Estos whsec_ son de LIVE. Ponelos en Netlify y recién ahí redeployás.\n');
  } else {
    console.log(' Esto fue en TEST. Para live: repetí con la clave live y --live.\n');
  }
}

main().catch((e) => {
  console.error('\n✖ Falló:', e?.message ?? e, '\n');
  process.exit(1);
});