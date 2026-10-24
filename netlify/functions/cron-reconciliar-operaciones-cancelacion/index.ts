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
 * Cron (BLOCK 2B): recupera operaciones de cancelación Stripe (iniciadas por
 * socio o recepción, BLOCK 2A) que quedaron 'en_ejecucion' por un fallo,
 * timeout o caída de proceso entre llamar a Stripe y confirmar en SALA.
 *
 * Nunca confía en el payload de ningún webhook ni en la intención original:
 * siempre vuelve a consultar Stripe EN VIVO (subscriptions.retrieve) y exige
 * dos lecturas consecutivas idénticas antes de resolver (ver
 * reconciliar_operacion_cancelacion). _reconciliador_reclamar_candidatos
 * garantiza que dos corridas de este cron nunca procesen la misma operación
 * a la vez (FOR UPDATE SKIP LOCKED + lease de 90s).
 *
 * Programado en netlify.toml cada 5 minutos. Usa service_role: no hay sesión
 * de usuario, por eso resuelve mediante funciones separadas a las de 2A
 * (nunca llama confirmar_operacion_cancelacion, que exige un actor real).
 */

function epochToISO(epoch: unknown): string | null {
  return typeof epoch === 'number' ? new Date(epoch * 1000).toISOString() : null;
}
function periodEndISO(sub: any): string | null {
  const item = sub?.items?.data?.[0];
  return epochToISO(sub?.current_period_end ?? item?.current_period_end ?? null);
}

const run: Handler = async () => {
  try {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: candidatas, error: errCand } = await supabase.rpc(
      '_reconciliador_reclamar_candidatos' as never,
      { p_limite: 25 } as never
    );
    if (errCand) {
      await reportarErrorServidor('cron-reconciliar-operaciones-cancelacion', new Error(errCand.message));
      return serverError(errCand.message);
    }

    const lista = (candidatas ?? []) as Array<{
      operacion_id: string;
      membresia_id: string;
      tenant_id: string;
      accion: string;
      stripe_subscription_id: string;
      lectura_previa: unknown;
    }>;

    if (lista.length === 0) {
      console.log('[cron-reconciliar-operaciones-cancelacion] OK', { candidatas: 0 });
      return ok({ candidatas: 0 });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      console.log('[cron-reconciliar-operaciones-cancelacion] OK', { candidatas: lista.length, reason: 'stripe_pendiente' });
      return ok({ candidatas: lista.length, reason: 'stripe_pendiente' });
    }
    const stripe = getStripe();

    const { data: tenantsData } = await supabase
      .from('tenants')
      .select('id, stripe_account_id')
      .in('id', lista.map((c) => c.tenant_id));
    const acctPorTenant = new Map<string, string | null>(
      (tenantsData ?? []).map((t: any) => [t.id, t.stripe_account_id ?? null])
    );

    let resueltas = 0, pendientesEstabilidad = 0, saltadas = 0;

    for (const c of lista) {
      const acct = acctPorTenant.get(c.tenant_id) ?? null;
      if (!acct) {
        saltadas++;
        await reportarErrorServidor(
          'cron-reconciliar-operaciones-cancelacion',
          new Error('tenant sin stripe_account_id'),
          { operacion_id: c.operacion_id, tenant_id: c.tenant_id }
        );
        continue;
      }
      try {
        const sub = await stripe.subscriptions.retrieve(c.stripe_subscription_id, {}, { stripeAccount: acct });
        const lecturaViva = {
          status: sub.status,
          cancel_at_period_end: sub.cancel_at_period_end,
          current_period_end: periodEndISO(sub)
        };

        const { data: res, error: errRec } = await supabase.rpc(
          'reconciliar_operacion_cancelacion' as never,
          { p_operacion_id: c.operacion_id, p_lectura_viva: lecturaViva } as never
        );
        if (errRec) throw new Error(errRec.message);

        if ((res as any)?.estable === false) pendientesEstabilidad++;
        else resueltas++;
      } catch (e) {
        saltadas++;
        console.error('[cron-reconciliar-operaciones-cancelacion] error en operación', c.operacion_id, e);
        await reportarErrorServidor('cron-reconciliar-operaciones-cancelacion', e, { operacion_id: c.operacion_id });
      }
    }

    console.log('[cron-reconciliar-operaciones-cancelacion] OK', {
      candidatas: lista.length, resueltas, pendientesEstabilidad, saltadas
    });
    return ok({ candidatas: lista.length, resueltas, pendientesEstabilidad, saltadas });
  } catch (e) {
    await reportarErrorServidor('cron-reconciliar-operaciones-cancelacion', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};

export const handler: Handler = conMonitorCron('cron-reconciliar-operaciones-cancelacion', '2/5 * * * *', run);
