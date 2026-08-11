import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { reportarErrorServidor } from '../_lib/sentry';
import { requireEnv } from '../_lib/env';
import { enviarPushAUsuario } from '../_lib/push';

/**
 * Cron: reparte por PUSH las notificaciones que todavía no salieron.
 *
 * En vez de cablear el envío en cada lugar que notifica (y olvidarse de la
 * mitad), toda notificación nace con push_enviado_at = NULL y este cron la
 * despacha. Así cualquier aviso nuevo —de un RPC, de un trigger o de un
 * webhook— sale por push sin tocar una línea de esta función.
 *
 * Sirve para los TRES roles: si un admin o un recepcionista suscribió su
 * teléfono, recibe los avisos del gym igual que el socio los suyos.
 *
 * Solo despacha lo RECIENTE (última hora): si el cron estuvo caído, no tiene
 * sentido despertar a alguien de madrugada con el recordatorio de una clase que
 * ya pasó.
 */

/** A dónde lleva el click, según el tipo de aviso. */
function urlDelAviso(tipo: string): string {
  switch (tipo) {
    case 'socio_nuevo':
    case 'cancelacion_tardia':
      return '/recepcion';
    case 'membresia_por_vencer':
    case 'membresia_vencida':
    case 'pago_rechazado':
      return '/app/perfil';
    default:
      return '/app';
  }
}

export const handler: Handler = async () => {
  try {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const desde = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const { data: pendientes, error } = await admin
      .from('notificaciones')
      .select('id, usuario_id, tipo, titulo, mensaje')
      .is('push_enviado_at', null)
      .gte('creada_at', desde)
      .order('creada_at', { ascending: true })
      .limit(200);

    if (error) {
      await reportarErrorServidor('cron-push', new Error(error.message));
      return serverError(error.message);
    }
    if (!pendientes || pendientes.length === 0) return ok({ enviadas: 0 });

    let entregas = 0;

    for (const n of pendientes) {
      entregas += await enviarPushAUsuario(admin, n.usuario_id, {
        titulo: n.titulo,
        mensaje: n.mensaje,
        url: urlDelAviso(n.tipo),
        tag: n.tipo
      });
    }

    // Se marcan como despachadas TENGAN o no dispositivos suscritos: si el
    // usuario no activó los avisos, no hay nada que reintentar mañana.
    const ids = pendientes.map((n) => n.id);
    await admin
      .from('notificaciones')
      .update({ push_enviado_at: new Date().toISOString() })
      .in('id', ids);

    return ok({ notificaciones: pendientes.length, entregas });
  } catch (err) {
    await reportarErrorServidor('cron-push', err);
    return serverError('No pudimos repartir los avisos');
  }
};
