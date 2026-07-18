import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22 no hay
// WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv, optionalEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import {
  lookupKeyFor,
  resolvePriceId,
  getOrCreateTenantCustomer,
  CICLOS_SAAS,
  type CicloSaas
} from '../_lib/saasBilling';

/**
 * POST /suscribir-saas — Flujo 1: el GYM (tenant) se suscribe al SaaS SALA.
 * Auth: Bearer JWT del ADMIN del gym.
 * Body: { tier: 'starter'|'pro'|'business', moneda: 'mxn'|'usd'|'eur',
 *         ciclo?: 'mensual'|'anual', return_path?: string }
 *
 * Crea una Stripe Checkout Session (mode: subscription, trial 7 días) sobre el
 * customer del tenant y devuelve { url }. La activación REAL de la suscripción
 * (escribir suscripciones_saas) la hace el webhook stripe-webhook-saas; acá NO
 * se toca el estado. El precio se resuelve por lookup_key (nunca price_id).
 */

const TRIAL_DIAS = 7;

interface Body {
  tier?: string;
  moneda?: string;
  ciclo?: string;
  return_path?: string;
  /** true → Embedded Checkout (modal en SALA, alta del gym): devuelve client_secret. */
  embedded?: boolean;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    const ciclo: CicloSaas = CICLOS_SAAS.includes(body.ciclo as CicloSaas)
      ? (body.ciclo as CicloSaas)
      : 'mensual';
    const lookupKey = lookupKeyFor(body.tier ?? '', body.moneda ?? '', ciclo);
    if (!lookupKey) return badRequest('Plan, moneda o ciclo inválido');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    // 1) Identificar al admin que pide (con su propio token) y validar rol.
    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: admin } = await asUser
      .from('usuarios')
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();

    if (!admin?.tenant_id) return forbidden('No encontramos tu cuenta');
    if (admin.rol !== 'admin' || admin.status !== 'activo') {
      return forbidden('Solo el admin del gym puede gestionar la suscripción');
    }

    // Deploy-safe: si Stripe aún no está conectado (sin claves), no cobramos ni
    // activamos nada → la UI muestra "pago en camino". Mismo contrato que el
    // socio (suscribir-membresia con reason 'stripe_pendiente').
    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ activated: false, reason: 'stripe_pendiente' });
    }

    // 2) Stripe: resolver price por lookup_key + get-or-create customer del tenant.
    const stripe = getStripe();
    const adminDb = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const priceId = await resolvePriceId(stripe, lookupKey);
    const customerId = await getOrCreateTenantCustomer(
      stripe,
      adminDb,
      admin.tenant_id,
      authUser.email ?? null
    );

    // 2b) CAMBIO DE PLAN in-place: si el tenant YA tiene una suscripción viva,
    //     NO creamos otra (evitaría DOBLE COBRO — Checkout siempre crea una sub
    //     nueva y nada cancelaba la vieja). Cambiamos el precio del item con
    //     proration_behavior 'create_prorations' contra la tarjeta en archivo,
    //     sin trial nuevo, y sincronizamos el snapshot.
    const { data: subActual } = await adminDb
      .from('suscripciones_saas')
      .select('stripe_subscription_id, estado')
      .eq('tenant_id', admin.tenant_id)
      .maybeSingle();

    const subIdActual = subActual?.stripe_subscription_id as string | undefined;
    if (
      subIdActual &&
      !subIdActual.startsWith('mock_') &&
      ['trial', 'activa', 'pausada'].includes(subActual?.estado as string)
    ) {
      const sub = await stripe.subscriptions.retrieve(subIdActual);
      const itemId = sub.items?.data?.[0]?.id;
      if (sub.status !== 'canceled' && itemId) {
        const updated = await stripe.subscriptions.update(subIdActual, {
          items: [{ id: itemId, price: priceId }],
          proration_behavior: 'create_prorations',
          metadata: { app: 'sala', tenant_id: admin.tenant_id, tier: body.tier!, moneda: body.moneda!, ciclo }
        });
        await adminDb
          .from('suscripciones_saas')
          .update({
            tier: body.tier!,
            moneda: body.moneda!,
            ciclo,
            stripe_price_id: priceId,
            cancel_at_period_end: updated.cancel_at_period_end ?? false
          })
          .eq('tenant_id', admin.tenant_id);
        return ok({ activated: true, cambio: 'prorrateado' });
      }
    }

    // 3) URLs de retorno (al panel de suscripción del admin).
    const origin =
      event.headers.origin ||
      event.headers.referer?.replace(/\/+$/, '') ||
      optionalEnv('APP_URL', 'https://salastudio.app');
    const returnPath = body.return_path && body.return_path.startsWith('/')
      ? body.return_path
      : '/admin/suscripcion';

    // 4) Checkout Session. metadata { app:'sala', tenant_id } en la SUSCRIPCIÓN
    //    → el webhook filtra por app y sabe a qué tenant aplicar (cuenta Stripe
    //    compartida con HSC). tier/moneda/ciclo viajan para el snapshot.
    const baseParams = {
      mode: 'subscription' as const,
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: TRIAL_DIAS,
        metadata: { app: 'sala', tenant_id: admin.tenant_id, tier: body.tier!, moneda: body.moneda!, ciclo }
      },
      metadata: { app: 'sala', tenant_id: admin.tenant_id },
      billing_address_collection: 'auto' as const,
      // En baseParams (no solo en el de redirect): el checkout EMBEBIDO del
      // registro no mostraba el campo de código promocional, así que un gym con
      // descuento pactado no podía aplicarlo durante el alta — el unico momento
      // en que la mayoria va a pagar.
      allow_promotion_codes: true
    };

    // Embedded → modal en SALA (alta del gym). SaaS = cuenta plataforma, sin Connect.
    if (body.embedded) {
      const session = await stripe.checkout.sessions.create({
        ...baseParams,
        ui_mode: 'embedded_page',
        redirect_on_completion: 'never'
      });
      return ok({ client_secret: session.client_secret });
    }

    const session = await stripe.checkout.sessions.create({
      ...baseParams,
      success_url: `${origin}${returnPath}?checkout=success`,
      cancel_url: `${origin}${returnPath}?checkout=cancel`
    });
    return ok({ url: session.url });
  } catch (err) {
    console.error('[suscribir-saas]', err instanceof Error ? err.message : err);
    return serverError('No pudimos iniciar el checkout');
  }
};
