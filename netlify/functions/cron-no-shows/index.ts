import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * Cron: cada hora, marca reservas no asistidas como no_show + bloquea usuario.
 *
 * Programado en netlify.toml como [[scheduled_functions]] con cron "0 * * * *"
 * (cada hora al minuto 0).
 *
 * Usa service_role porque debe poder modificar reservas y usuarios de cualquier
 * tenant sin contexto de sesión.
 */
export const handler: Handler = async () => {
  try {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase.rpc('marcar_no_shows');

    if (error) {
      console.error('[cron-no-shows]', error);
      return serverError(error.message);
    }

    console.log('[cron-no-shows] OK', data);
    return ok(data);
  } catch (e) {
    console.error('[cron-no-shows] Error', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
