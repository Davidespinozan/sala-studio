import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { reportarErrorServidor, conMonitorCron } from '../_lib/sentry';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';

/**
 * Cron (BLOCK 1C): cierra las cancelaciones Stripe DIFERIDAS cuya vigencia
 * pagada ya venció — el webhook (BLOCK 1B) solo marca la cancelación cuando
 * aún queda tiempo pagado; nada más vuelve a tocar esa fila sin este barrido,
 * porque Stripe no re-emite subscription.deleted. Reconsulta candidatas en
 * cada corrida (sin columna de dedup): el volumen esperado es bajo y la
 * idempotencia real vive en las RPC (lock + re-chequeo de status), no aquí.
 *
 * Por cada candidata confirma EN VIVO contra Stripe antes de actuar:
 *   - sigue 'canceled' en Stripe → _stripe_finalizar_membresia_diferida
 *     (status→cancelada, créditos a 0, libera reservas).
 *   - Stripe dice que ya no (reactivada directo en Stripe, fuera de SALA)
 *     → _stripe_limpiar_cancelacion_diferida (borra la marca diferida).
 *
 * Programado en netlify.toml como [functions."cron-cerrar-cancelaciones-stripe"].
 * Usa service_role: toca membresías de cualquier tenant sin sesión.
 */

const run: Handler = async () => {
  try {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: candidatas, error: errCand } = await supabase.rpc(
      '_stripe_candidatos_cierre_diferido' as never,
      {} as never
    );
    if (errCand) {
      await reportarErrorServidor('cron-cerrar-cancelaciones-stripe', new Error(errCand.message));
      return serverError(errCand.message);
    }

    const todas = (candidatas ?? []) as Array<{
      membresia_id: string;
      stripe_subscription_id: string;
      cancelada_efectiva_at: string;
    }>;
    // Tope por corrida: es un barrido de recuperación (volumen normal = 0),
    // no la ruta en tiempo real. Sin columna de dedup, lo que sobra en esta
    // corrida sigue siendo candidato en la siguiente (cada 4h) — no se pierde,
    // solo se reparte en más corridas si algún día hay un pico grande.
    const lista = todas.slice(0, 30);

    if (lista.length === 0) {
      console.log('[cron-cerrar-cancelaciones-stripe] OK', { candidatas: 0 });
      return ok({ finalizadas: 0, limpiadas: 0, saltadas: 0 });
    }

    const { data: filas } = await supabase
      .from('membresias')
      .select('id, tenant_id, tenants(stripe_account_id)')
      .in('id', lista.map((c) => c.membresia_id));
    const acctPorMembresia = new Map<string, string | null>(
      (filas ?? []).map((f: any) => [f.id, f.tenants?.stripe_account_id ?? null])
    );

    if (!process.env.STRIPE_SECRET_KEY) {
      // Sin Stripe configurado en este entorno: nada que confirmar en vivo.
      console.log('[cron-cerrar-cancelaciones-stripe] OK', { candidatas: lista.length, reason: 'stripe_pendiente' });
      return ok({ finalizadas: 0, limpiadas: 0, saltadas: lista.length });
    }
    const stripe = getStripe();

    let finalizadas = 0, limpiadas = 0, saltadas = 0;

    for (const c of lista) {
      const acct = acctPorMembresia.get(c.membresia_id) ?? null;
      if (!acct) { saltadas++; continue; }
      try {
        const sub = await stripe.subscriptions.retrieve(c.stripe_subscription_id, {}, { stripeAccount: acct });
        if (sub.status === 'canceled') {
          const { data: res, error: errFin } = await supabase.rpc(
            '_stripe_finalizar_membresia_diferida' as never,
            { p_membresia_id: c.membresia_id } as never
          );
          if (errFin) throw new Error(errFin.message);
          if ((res as any)?.applied) finalizadas++; else saltadas++;
        } else if (sub.cancel_at_period_end === false) {
          // Reactivada de verdad: Stripe confirma que la cancelación programada
          // se revirtió (no solo que "todavía no está canceled").
          const { error: errLimpia } = await supabase.rpc(
            '_stripe_limpiar_cancelacion_diferida' as never,
            { p_membresia_id: c.membresia_id } as never
          );
          if (errLimpia) throw new Error(errLimpia.message);
          limpiadas++;
        } else {
          // Ni 'canceled' ni reactivada: cancel_at_period_end sigue true, Stripe
          // probablemente aún no procesó el fin de periodo (desfase con el
          // cancelada_efectiva_at calculado por SALA). No tocar nada — sigue
          // siendo candidata en la próxima corrida.
          saltadas++;
        }
      } catch (e) {
        saltadas++;
        console.error('[cron-cerrar-cancelaciones-stripe] error en membresía', c.membresia_id, e);
        // Best-effort: una membresía que falla repetido (cuenta Stripe
        // desconectada, suscripción borrada) debe alertar, no solo quedar en
        // logs — si no, nadie se entera de que algo se atora corrida tras corrida.
        await reportarErrorServidor('cron-cerrar-cancelaciones-stripe', e, { membresia_id: c.membresia_id });
      }
    }

    console.log('[cron-cerrar-cancelaciones-stripe] OK', { candidatas: todas.length, procesadas: lista.length, finalizadas, limpiadas, saltadas });
    return ok({ candidatas: todas.length, finalizadas, limpiadas, saltadas });
  } catch (e) {
    await reportarErrorServidor('cron-cerrar-cancelaciones-stripe', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};

export const handler: Handler = conMonitorCron('cron-cerrar-cancelaciones-stripe', '20 */4 * * *', run);
