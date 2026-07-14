import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';
import { optionalEnv } from './env';

/**
 * Envío de notificaciones push (Web Push + VAPID).
 *
 * Reglas de la casa:
 *  · Sin claves VAPID no explota: se salta el envío y lo dice en el log. La
 *    notificación in-app ya quedó guardada, así que el usuario igual se entera
 *    al abrir la app. (En ekko esto quedó en no-op silencioso justamente por no
 *    haber seteado las claves: acá al menos queda registrado.)
 *  · Una suscripción muerta (404/410) se borra sola: son dispositivos que
 *    desinstalaron la app o limpiaron el navegador. Si no, se acumulan para
 *    siempre y cada envío tarda más.
 *  · Nunca lanza: un push que falla no puede tumbar el cron ni el webhook.
 */

let configurado = false;

function configurar(): boolean {
  if (configurado) return true;

  const publica = optionalEnv('VAPID_PUBLIC_KEY', '');
  const privada = optionalEnv('VAPID_PRIVATE_KEY', '');
  const sujeto = optionalEnv('VAPID_SUBJECT', 'mailto:hola@salastudio.app');

  if (!publica || !privada) {
    console.warn('[push] Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY: no se envía push.');
    return false;
  }

  webpush.setVapidDetails(sujeto, publica, privada);
  configurado = true;
  return true;
}

export interface AvisoPush {
  titulo: string;
  mensaje: string;
  /** A dónde lleva el click. Default: la app del socio. */
  url?: string;
  /** Misma tag = reemplaza el aviso anterior en vez de apilar. */
  tag?: string;
}

/**
 * Manda el aviso a TODOS los dispositivos del usuario.
 * Devuelve cuántos se entregaron.
 */
export async function enviarPushAUsuario(
  admin: SupabaseClient,
  usuarioId: string,
  aviso: AvisoPush
): Promise<number> {
  if (!configurar()) return 0;

  const { data: subs, error } = await admin
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('usuario_id', usuarioId);

  if (error || !subs || subs.length === 0) return 0;

  const payload = JSON.stringify({
    titulo: aviso.titulo,
    mensaje: aviso.mensaje,
    url: aviso.url ?? '/app',
    tag: aviso.tag ?? 'sala'
  });

  let entregados = 0;

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload
        );
        entregados++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // Dispositivo que ya no existe → limpiar, no reintentar para siempre.
        if (status === 404 || status === 410) {
          await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        } else {
          console.error('[push] envío falló', status, (err as Error).message);
        }
      }
    })
  );

  return entregados;
}
