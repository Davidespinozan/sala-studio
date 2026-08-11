import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { reportarErrorServidor } from '../_lib/sentry';
import { requireEnv } from '../_lib/env';

/**
 * Cron diario: le avisa al socio que su plan está por vencer.
 *
 * Era el hueco más caro del sistema: NADIE le avisaba. El socio descubría que su
 * plan venció cuando ya no podía reservar — o sea, cuando ya lo perdiste.
 *
 * El aviso se manda una sola vez por periodo (la RPC lo controla con
 * membresias.aviso_vencimiento_at). El push sale solo, vía cron-push.
 */

const DIAS_DE_AVISO = 3;

export const handler: Handler = async () => {
  try {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data, error } = await admin.rpc('avisar_membresias_por_vencer', {
      p_dias: DIAS_DE_AVISO
    });
    if (error) {
      await reportarErrorServidor('cron-membresias-por-vencer', new Error(error.message));
      return serverError(error.message);
    }

    return ok({ avisados: data ?? 0 });
  } catch (err) {
    await reportarErrorServidor('cron-membresias-por-vencer', err);
    return serverError('No pudimos avisar los vencimientos');
  }
};
