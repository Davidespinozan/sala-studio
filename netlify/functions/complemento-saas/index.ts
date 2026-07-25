import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { resolvePriceId } from '../_lib/saasBilling';

/**
 * POST /complemento-saas — activar o cancelar un complemento (hoy: la Tienda).
 * -------------------------------------------------------------------------
 * SELF-SERVE: el gym lo activa solo desde su admin, con la tarjeta que YA tiene
 * de su plan. No abre checkout ni pide nada — le agrega un SEGUNDO renglón a la
 * suscripción existente y se cobra a esa tarjeta. Cancelar quita el renglón.
 *
 * El complemento se cobra POR SUCURSAL: el renglón lleva `quantity = sucursales
 * activas`. Un gym de una sede paga 1×; una cadena, tantas como sedes.
 *
 * NO prende el módulo acá: lo hace el WEBHOOK cuando Stripe confirma el cambio.
 * Una sola fuente de verdad (Stripe) evita que el gym vea la tienda prendida sin
 * que el cobro haya entrado, o al revés.
 */

const COMPLEMENTOS = {
  tienda: { lookupPrefix: 'sala_tienda' }
} as const;
type ComplementoId = keyof typeof COMPLEMENTOS;

interface Body {
  modulo?: string;
  accion?: 'activar' | 'cancelar';
}

// ¿Este renglón de Stripe es el complemento pedido?
function esDeComplemento(item: any, id: ComplementoId): boolean {
  const p = item?.price;
  const prefix = COMPLEMENTOS[id].lookupPrefix;
  return typeof p?.lookup_key === 'string'
    ? p.lookup_key.startsWith(prefix)
    : p?.metadata?.addon === id;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const userToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!userToken) return unauthorized('Falta el token');

    const body: Body = JSON.parse(event.body || '{}');
    const modulo = body.modulo as ComplementoId;
    if (!modulo || !(modulo in COMPLEMENTOS)) return badRequest('Complemento inválido');
    if (body.accion !== 'activar' && body.accion !== 'cancelar') return badRequest('Acción inválida');

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
      .select('tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!admin?.tenant_id) return forbidden('No encontramos tu cuenta');
    if (admin.rol !== 'admin' || admin.status !== 'activo') {
      return forbidden('Solo el admin del gym puede gestionar los complementos');
    }

    const adminDb = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // 2) El gym tiene que tener un plan REAL para colgarle un complemento. Un
    //    add-on es un renglón de una suscripción — si no hay suscripción viva
    //    (o es un mock), no hay dónde ponerlo.
    const { data: sus } = await adminDb
      .from('suscripciones_saas')
      .select('stripe_subscription_id, moneda, estado')
      .eq('tenant_id', admin.tenant_id)
      .maybeSingle();

    const subId = sus?.stripe_subscription_id as string | undefined;
    if (!subId || subId.startsWith('mock_')) {
      return badRequest('Primero activá tu plan con una tarjeta; después podés sumar la tienda.');
    }

    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subId);
    if (sub.status === 'canceled') {
      return badRequest('Tu suscripción está cancelada. Reactivá tu plan primero.');
    }

    const itemExistente = sub.items?.data?.find((i) => esDeComplemento(i, modulo));

    // ── CANCELAR ────────────────────────────────────────────────────────────
    if (body.accion === 'cancelar') {
      if (!itemExistente) return ok({ ya: true }); // no lo tenía: nada que hacer
      await stripe.subscriptionItems.del(itemExistente.id, { proration_behavior: 'create_prorations' });
      return ok({ cancelado: true }); // el webhook apaga el módulo
    }

    // ── ACTIVAR ─────────────────────────────────────────────────────────────
    if (itemExistente) return ok({ ya: true }); // ya lo tenía: idempotente

    const moneda = String(sus?.moneda || 'mxn').toLowerCase();
    const priceId = await resolvePriceId(stripe, `${COMPLEMENTOS[modulo].lookupPrefix}_${moneda}`);

    // Cantidad = sucursales activas del gym (mínimo 1). El complemento se cobra
    // por sede; si mañana abre otra, la cantidad se ajusta (ver sync de sedes).
    const { count } = await adminDb
      .from('sucursales')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', admin.tenant_id)
      .eq('activa', true);
    const quantity = Math.max(1, count ?? 1);

    await stripe.subscriptionItems.create({
      subscription: subId,
      price: priceId,
      quantity,
      // Cobra la parte proporcional de este ciclo contra la tarjeta en archivo.
      proration_behavior: 'create_prorations'
    });

    return ok({ activado: true, sucursales: quantity }); // el webhook prende el módulo
  } catch (e) {
    console.error('[complemento-saas] error:', e instanceof Error ? e.message : e);
    return serverError('No se pudo procesar el complemento');
  }
};