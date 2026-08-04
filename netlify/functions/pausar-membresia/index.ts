import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';

/**
 * POST /pausar-membresia — Flujo 2: recepción/admin CONGELA o REACTIVA la
 * membresía de un socio, PAUSANDO/REANUDANDO también su suscripción de Stripe
 * (si tiene una viva). Sin esto, un socio congelado seguía pagando cada mes.
 *
 * Auth: Bearer JWT del staff. Body: { usuario_id, modo:'pausar'|'reactivar', motivo }.
 * Orden: pausa/reanuda Stripe → llama la RPC (con el token del staff, así se
 * mantienen el gate de rol y la bitácora). Si la RPC falla, se revierte Stripe.
 */

interface Body {
  usuario_id?: string;
  modo?: 'pausar' | 'reactivar';
  motivo?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    const modo = body.modo === 'reactivar' ? 'reactivar' : body.modo === 'pausar' ? 'pausar' : null;
    if (!body.usuario_id || !modo) return badRequest('Faltan usuario_id o modo');
    if (!body.motivo || !body.motivo.trim()) return badRequest('Falta el motivo');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: staff } = await asUser
      .from('usuarios')
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!staff || staff.status !== 'activo' || (staff.rol !== 'recepcionista' && staff.rol !== 'admin')) {
      return forbidden('Solo recepción o admin pueden pausar membresías');
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Suscripción de Stripe del socio (si tiene una viva) + cuenta conectada.
    const rpcName = modo === 'pausar' ? 'recepcion_congelar_membresia' : 'recepcion_reactivar_membresia';
    const rpcArgs = { p_usuario_id: body.usuario_id, p_motivo: body.motivo.trim() };

    let acct: string | null = null;
    let subId: string | null = null;
    if (process.env.STRIPE_SECRET_KEY) {
      const { data: mem } = await admin
        .from('membresias')
        .select('stripe_subscription_id, tenant_id')
        .eq('usuario_id', body.usuario_id)
        .in('status', ['activa', 'trialing', 'past_due', 'congelada'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      // Aislamiento entre tenants: NO tocar el Stripe de una membresía de otro gym.
      // El RPC de abajo ya valida, pero corre DESPUÉS de tocar Stripe; esto es antes.
      if (mem && mem.tenant_id !== staff.tenant_id) {
        return forbidden('No puedes modificar la membresía de otro gimnasio');
      }
      subId = (mem?.stripe_subscription_id as string | null) ?? null;
      if (subId && !subId.startsWith('mock_') && mem?.tenant_id) {
        const { data: tenant } = await admin
          .from('tenants')
          .select('stripe_account_id')
          .eq('id', mem.tenant_id)
          .maybeSingle();
        acct = tenant?.stripe_account_id ?? null;
      } else {
        subId = null; // paquete / demo → sin sub de Stripe que pausar
      }
    }

    const stripe = subId && acct ? getStripe() : null;
    const pausePayload = modo === 'pausar' ? { behavior: 'void' as const } : null;

    // 1) Stripe primero (para poder revertir si la RPC rechaza).
    if (stripe && subId && acct) {
      await stripe.subscriptions.update(subId, { pause_collection: pausePayload }, { stripeAccount: acct });
    }

    // 2) RPC con el token del staff (mantiene gate de rol + bitácora + validación).
    const { data, error } = await asUser.rpc(rpcName, rpcArgs);
    if (error) {
      // Rollback de Stripe: dejar la suscripción como estaba.
      if (stripe && subId && acct) {
        const revert = modo === 'pausar' ? null : { behavior: 'void' as const };
        try {
          await stripe.subscriptions.update(subId, { pause_collection: revert }, { stripeAccount: acct });
        } catch (e) {
          console.error('[pausar-membresia] rollback Stripe falló:', e instanceof Error ? e.message : e);
        }
      }
      // El mensaje de la RPC ("CODIGO: humano") → parte legible.
      const humano = error.message.includes(': ') ? error.message.split(': ').slice(1).join(': ') : error.message;
      return badRequest(humano);
    }

    return ok({ success: true, result: data, stripe_pausado: !!subId });
  } catch (err) {
    console.error('[pausar-membresia]', err instanceof Error ? err.message : err);
    return serverError('No pudimos actualizar la membresía');
  }
};
