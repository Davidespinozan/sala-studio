import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * Cron: cada hora, marca reservas no asistidas como no_show + bloquea usuario
 * y expira entradas de lista de espera cuyo slot ya pasó (devuelve crédito).
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

    const { data: noShowsData, error: noShowsErr } = await supabase.rpc('marcar_no_shows');
    if (noShowsErr) {
      console.error('[cron-no-shows] marcar_no_shows', noShowsErr);
      return serverError(noShowsErr.message);
    }

    // D-011: expirar entradas de lista_espera vencidas (refunda crédito si había débito).
    const { data: expiradasData, error: expiradasErr } = await supabase.rpc(
      'expirar_listas_espera_vencidas'
    );
    if (expiradasErr) {
      console.error('[cron-no-shows] expirar_listas_espera_vencidas', expiradasErr);
      return serverError(expiradasErr.message);
    }

    console.log('[cron-no-shows] OK', { noShows: noShowsData, expiradas: expiradasData });
    return ok({ noShows: noShowsData, expiradas: expiradasData });
  } catch (e) {
    console.error('[cron-no-shows] Error', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
