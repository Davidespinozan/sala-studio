import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22 no hay
// WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv, optionalEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { getOrCreateSocioCustomer } from '../_lib/connectBilling';

/**
 * POST /suscribir-membresia
 * Auth: Bearer JWT del SOCIO.
 * Body: { tier_id: string }
 *
 * Compra/cambio de membresía del socio:
 *   - Tenant DEMO → activa con pago SIMULADO (activar_suscripcion_socio).
 *   - Tenant REAL → Flujo 2 (Connect): crea una Checkout Session sobre la CUENTA
 *     CONECTADA del gym (direct charge, precio inline del tier, application_fee
 *     de SALA) y devuelve { url }. La activación real la dispara el webhook de
 *     Connect (stripe-webhook) vía activar_suscripcion_socio. Acá NO se activa.
 *   - Si el gym no activó cobros → { activated:false, reason:'cobros_no_activos' }.
 *   - Si Stripe no está conectado → { activated:false, reason:'stripe_pendiente' }.
 */

const DEMO_TENANT_SLUG = 'healthyspace';

interface Body {
  tier_id?: string;
  /** true → Embedded Checkout (modal en SALA): devuelve client_secret en vez de url. */
  embedded?: boolean;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.tier_id) return badRequest('Falta tier_id');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    // 1) Identificar al socio (con su propio token).
    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: socio } = await asUser
      .from('usuarios')
      .select('id, tenant_id, rol, stripe_customer_id')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return unauthorized('Sin perfil');
    if (socio.rol !== 'miembro') return badRequest('Solo un socio puede comprar membresía');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // 2) Tenant (gate del demo + cuenta conectada del gym).
    const { data: tenant } = await admin
      .from('tenants')
      .select('slug, stripe_account_id, stripe_charges_enabled')
      .eq('id', socio.tenant_id)
      .maybeSingle();
    const esDemo = tenant?.slug === DEMO_TENANT_SLUG;

    // 3) Validar el tier (de su tenant, activo) + traer precio/moneda/nombre.
    const { data: tier } = await admin
      .from('tiers')
      .select('id, activo, tenant_id, nombre, precio_centavos, moneda, tipo')
      .eq('id', body.tier_id)
      .maybeSingle();
    if (!tier || tier.tenant_id !== socio.tenant_id || tier.activo !== true) {
      return badRequest('Plan inválido');
    }

    // ── DEMO: pago simulado → activar de una vez (misma RPC que el webhook). ──
    if (esDemo) {
      const { data: result, error: rpcErr } = await admin.rpc('activar_suscripcion_socio', {
        p_usuario_id: socio.id,
        p_tier_id: body.tier_id
      });
      if (rpcErr) return serverError(rpcErr.message);
      return ok({ activated: true, result });
    }

    // ── TENANT REAL — Flujo 2 (Connect direct charge) ──
    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ activated: false, reason: 'stripe_pendiente' });
    }
    if (!tenant?.stripe_account_id || tenant.stripe_charges_enabled !== true) {
      // El gym todavía no activó cobros (o falta verificación de Stripe).
      return ok({ activated: false, reason: 'cobros_no_activos' });
    }

    // Tier gratis (precio 0): no hay nada que cobrar → activar directo.
    if (!Number.isInteger(tier.precio_centavos) || tier.precio_centavos <= 0) {
      const { data: result, error: rpcErr } = await admin.rpc('activar_suscripcion_socio', {
        p_usuario_id: socio.id,
        p_tier_id: body.tier_id
      });
      if (rpcErr) return serverError(rpcErr.message);
      return ok({ activated: true, result });
    }

    const stripe = getStripe();
    const acct = tenant.stripe_account_id;

    // Customer del socio EN la cuenta conectada (direct charges).
    const customerId = await getOrCreateSocioCustomer(
      stripe,
      admin,
      { id: socio.id, email: authUser.email ?? null, stripe_customer_id: socio.stripe_customer_id },
      acct
    );

    // Comisión de SALA sobre el cobro del socio (hoy 0% → se omite).
    const feePct = Number(optionalEnv('SALA_SOCIO_FEE_PERCENT', '0')) || 0;

    const origin =
      event.headers.origin ||
      event.headers.referer?.replace(/\/+$/, '') ||
      optionalEnv('APP_URL', 'https://salastudio.app');

    const meta = { app: 'sala', usuario_id: socio.id, tier_id: tier.id };
    const currency = (tier.moneda || 'mxn').toLowerCase();

    // ── Cambio de plan MENSUAL → MENSUAL: swap in-place con prorrateo. Si el
    //    socio ya tiene una suscripción activa y el nuevo tier también es mensual
    //    (tipo 'tiempo'), NO abrimos un checkout nuevo (evita duplicar la
    //    suscripción y re-pedir la tarjeta): cambiamos el precio del item con
    //    proration_behavior 'create_prorations' (la diferencia se ajusta en el
    //    próximo ciclo, contra la tarjeta guardada) y sincronizamos la membresía.
    if (tier.tipo === 'tiempo') {
      const { data: memActual } = await admin
        .from('membresias')
        .select('stripe_subscription_id')
        .eq('usuario_id', socio.id)
        .in('status', ['activa', 'trialing', 'past_due'])
        .not('stripe_subscription_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const subId = memActual?.stripe_subscription_id as string | undefined;
      if (subId) {
        const sub = await stripe.subscriptions.retrieve(subId, {}, { stripeAccount: acct });
        const itemId = sub.items?.data?.[0]?.id;
        if (sub.status !== 'canceled' && itemId) {
          // Price nuevo al vuelo (con su product) para el nuevo tier.
          const nuevoPrice = await stripe.prices.create(
            {
              currency,
              unit_amount: tier.precio_centavos,
              recurring: { interval: 'month' },
              product_data: { name: tier.nombre }
            },
            { stripeAccount: acct }
          );
          const updated = await stripe.subscriptions.update(
            subId,
            {
              items: [{ id: itemId, price: nuevoPrice.id }],
              proration_behavior: 'create_prorations',
              metadata: meta
            },
            { stripeAccount: acct }
          );
          const cpe =
            (updated as any).current_period_end ??
            (updated as any).items?.data?.[0]?.current_period_end ??
            null;
          const periodoFin = typeof cpe === 'number' ? new Date(cpe * 1000).toISOString() : null;

          const { error: rpcErr } = await admin.rpc('activar_suscripcion_socio', {
            p_usuario_id: socio.id,
            p_tier_id: tier.id,
            p_stripe_subscription_id: subId,
            p_stripe_customer_id: customerId,
            p_periodo_fin: periodoFin
          });
          if (rpcErr) return serverError(rpcErr.message);
          return ok({ activated: true, cambio: 'prorrateado' });
        }
      }
    }

    // Paquete de clases (creditos/hibrido) → PAGO ÚNICO. Mensualidad (tiempo) →
    // SUSCRIPCIÓN recurrente. El webhook materializa la membresía en ambos casos.
    const esPaquete = tier.tipo === 'creditos' || tier.tipo === 'hibrido';

    const baseParams = esPaquete
      ? {
          mode: 'payment' as const,
          customer: customerId,
          line_items: [
            {
              price_data: { currency, product_data: { name: tier.nombre }, unit_amount: tier.precio_centavos },
              quantity: 1
            }
          ],
          payment_intent_data: {
            metadata: meta,
            setup_future_usage: 'on_session' as const, // guarda la tarjeta para re-comprar
            ...(feePct > 0 ? { application_fee_amount: Math.round((tier.precio_centavos * feePct) / 100) } : {})
          },
          metadata: meta
        }
      : {
          mode: 'subscription' as const,
          customer: customerId,
          line_items: [
            {
              price_data: { currency, product_data: { name: tier.nombre }, unit_amount: tier.precio_centavos, recurring: { interval: 'month' as const } },
              quantity: 1
            }
          ],
          subscription_data: {
            metadata: meta,
            ...(feePct > 0 ? { application_fee_percent: feePct } : {})
          },
          metadata: meta
        };

    // Embedded → modal en SALA (devuelve client_secret + la cuenta conectada,
    // que el front necesita para inicializar Stripe.js sobre esa cuenta).
    if (body.embedded) {
      const session = await stripe.checkout.sessions.create(
        { ...baseParams, ui_mode: 'embedded_page', redirect_on_completion: 'never' },
        { stripeAccount: acct }
      );
      return ok({ activated: false, client_secret: session.client_secret, account: acct });
    }

    // Hosted (redirect) — fallback.
    const session = await stripe.checkout.sessions.create(
      { ...baseParams, success_url: `${origin}/app?compra=ok`, cancel_url: `${origin}/app?compra=cancel` },
      { stripeAccount: acct }
    );
    return ok({ activated: false, url: session.url });
  } catch (err) {
    console.error('[suscribir-membresia]', err instanceof Error ? err.message : err);
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
