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
 * Cron: cada hora, marca reservas no asistidas como no_show + bloquea usuario
 * y expira entradas de lista de espera cuyo slot ya pasó (devuelve crédito).
 *
 * Programado en netlify.toml como [functions."cron-no-shows"] con schedule "0 * * * *"
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
      await reportarErrorServidor('cron-no-shows', new Error(noShowsErr.message), { rpc: 'marcar_no_shows' });
      return serverError(noShowsErr.message);
    }

    // D-011: expirar entradas de lista_espera vencidas (refunda crédito si había débito).
    const { data: expiradasData, error: expiradasErr } = await supabase.rpc(
      'expirar_listas_espera_vencidas'
    );
    if (expiradasErr) {
      await reportarErrorServidor('cron-no-shows', new Error(expiradasErr.message), { rpc: 'expirar_listas_espera_vencidas' });
      return serverError(expiradasErr.message);
    }

    console.log('[cron-no-shows] OK', { noShows: noShowsData, expiradas: expiradasData });
    return ok({ noShows: noShowsData, expiradas: expiradasData });
  } catch (e) {
    await reportarErrorServidor('cron-no-shows', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
