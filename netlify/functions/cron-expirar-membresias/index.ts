import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { reportarErrorServidor, conMonitorCron } from '../_lib/sentry';
import { requireEnv } from '../_lib/env';

/**
 * Cron: una vez al día marca como 'expirada' las membresías NO-Stripe cuyo
 * periodo_actual_fin ya pasó. Sin esto, la expiración era solo "lazy" (al
 * reservar) y los reportes sobrecontaban socios activos.
 *
 * Además es el CENTINELA de salud de la plataforma:
 *   - Cron Monitor de Sentry (conMonitorCron): si este cron no corre a su hora,
 *     Sentry alerta por correo — el modo de falla que tuvimos semanas sin ver.
 *   - Chequeos de frescura: verifica que los EFECTOS de los otros crons estén
 *     ocurriendo (push repartidos, no-shows procesados). Si algo está rancio,
 *     reporta a Sentry como error con el diagnóstico.
 *
 * Programado en netlify.toml como [functions."cron-expirar-membresias"] con schedule "0 7 * * *".
 * Usa service_role: modifica membresías de cualquier tenant sin sesión.
 */

/** Efectos de los otros crons que deberían estar frescos. Solo lee y reporta. */
async function chequeosDeFrescura(supabase: SupabaseClient): Promise<void> {
  // cron-push (cada minuto): un aviso pendiente de >2h = el repartidor no corre
  // o web-push está roto.
  const { count: pushViejos } = await supabase
    .from('notificaciones')
    .select('id', { count: 'exact', head: true })
    .is('push_enviado_at', null)
    .lt('creada_at', new Date(Date.now() - 2 * 3600_000).toISOString());
  if ((pushViejos ?? 0) > 0) {
    await reportarErrorServidor(
      'salud-plataforma',
      new Error(`cron-push atrasado: ${pushViejos} avisos pendientes con más de 2 horas`),
      { chequeo: 'push_pendientes_viejos' }
    );
  }

  // cron-no-shows (cada hora): reservas confirmadas cuya clase terminó hace >36h
  // deberían ya estar completadas/no-show.
  const { count: sinProcesar } = await supabase
    .from('reservas')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'confirmada')
    .lt('slot_fin', new Date(Date.now() - 36 * 3600_000).toISOString());
  if ((sinProcesar ?? 0) > 0) {
    await reportarErrorServidor(
      'salud-plataforma',
      new Error(`cron-no-shows atrasado: ${sinProcesar} reservas pasadas siguen 'confirmada' tras 36h`),
      { chequeo: 'reservas_sin_procesar' }
    );
  }
}

const run: Handler = async () => {
  try {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase.rpc('expirar_membresias_vencidas');
    if (error) {
      await reportarErrorServidor('cron-expirar-membresias', new Error(error.message));
      return serverError(error.message);
    }

    // Salud del resto de la plataforma (nunca tira el cron principal).
    try {
      await chequeosDeFrescura(supabase);
    } catch (e) {
      await reportarErrorServidor('salud-plataforma', e, { chequeo: 'chequeos_de_frescura' });
    }

    console.log('[cron-expirar-membresias] OK', { expiradas: data });
    return ok({ expiradas: data });
  } catch (e) {
    await reportarErrorServidor('cron-expirar-membresias', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};

export const handler: Handler = conMonitorCron('cron-expirar-membresias', '0 7 * * *', run);
