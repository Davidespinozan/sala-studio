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
 * Cron diario: felicita por su cumpleaños a los socios que cumplen hoy.
 *
 * Usa la fecha de nacimiento de la ficha (usuarios_datos_privados). La RPC crea
 * la notificación una sola vez por día; el push sale solo, vía cron-push.
 */
export const handler: Handler = async () => {
  try {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data, error } = await admin.rpc('generar_felicitaciones_cumpleanos');
    if (error) {
      await reportarErrorServidor('cron-felicitaciones', new Error(error.message));
      return serverError(error.message);
    }

    return ok({ felicitados: data ?? 0 });
  } catch (err) {
    await reportarErrorServidor('cron-felicitaciones', err);
    return serverError('No pudimos generar las felicitaciones');
  }
};
