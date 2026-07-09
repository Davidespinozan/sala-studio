import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * Cron: cada 15 min genera recordatorios in-app de las clases que empiezan en
 * ~45-75 min (una notificación por reserva confirmada, sin duplicar). Feature de
 * retención. Programado en netlify.toml como [[scheduled_functions]] cada 15 min.
 * Usa service_role: escribe notificaciones de cualquier tenant sin sesión.
 */
export const handler: Handler = async () => {
  try {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase.rpc('generar_recordatorios_reservas');
    if (error) {
      console.error('[cron-recordatorios] generar_recordatorios_reservas', error);
      return serverError(error.message);
    }

    console.log('[cron-recordatorios] OK', { recordatorios: data });
    return ok({ recordatorios: data });
  } catch (e) {
    console.error('[cron-recordatorios] Error', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
