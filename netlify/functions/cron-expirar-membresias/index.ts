import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * Cron: una vez al día marca como 'expirada' las membresías NO-Stripe cuyo
 * periodo_actual_fin ya pasó. Sin esto, la expiración era solo "lazy" (al
 * reservar) y los reportes sobrecontaban socios activos.
 *
 * Programado en netlify.toml como [functions."cron-expirar-membresias"] con schedule "0 7 * * *".
 * Usa service_role: modifica membresías de cualquier tenant sin sesión.
 */
export const handler: Handler = async () => {
  try {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase.rpc('expirar_membresias_vencidas');
    if (error) {
      console.error('[cron-expirar-membresias] expirar_membresias_vencidas', error);
      return serverError(error.message);
    }

    console.log('[cron-expirar-membresias] OK', { expiradas: data });
    return ok({ expiradas: data });
  } catch (e) {
    console.error('[cron-expirar-membresias] Error', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
