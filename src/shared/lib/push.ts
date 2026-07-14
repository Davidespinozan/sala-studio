import { supabase } from '@shared/lib/supabase';

/**
 * Cliente de notificaciones push. Sirve para los TRES roles: el socio, la
 * recepción y el admin — todos usan la misma tabla y el mismo botón.
 *
 * iOS es el caso especial: Safari solo permite push si la web está INSTALADA
 * como app (añadida a la pantalla de inicio). Si no, pedir permiso falla sin
 * explicación, así que lo detectamos antes y le decimos al usuario qué hacer.
 */

export type EstadoPush =
  | 'no-soportado'      // el navegador no tiene push (o falta el service worker)
  | 'necesita-instalar' // iOS en el navegador: hay que agregarla a inicio primero
  | 'denegado'          // el usuario bloqueó los avisos
  | 'activo'            // suscrito en este dispositivo
  | 'inactivo';         // soportado, con permiso disponible, sin suscribir

export function pushSoportado(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function esIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

/** ¿La PWA está corriendo instalada (no en una pestaña del navegador)? */
export function esStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** iOS solo entrega push a la app instalada. */
export function necesitaInstalar(): boolean {
  return esIOS() && !esStandalone();
}

export async function estadoPush(): Promise<EstadoPush> {
  if (!pushSoportado()) return 'no-soportado';
  if (necesitaInstalar()) return 'necesita-instalar';
  if (Notification.permission === 'denied') return 'denegado';

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'activo' : 'inactivo';
}

/** VAPID en base64url → el Uint8Array que espera pushManager.subscribe. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const salida = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) salida[i] = raw.charCodeAt(i);
  return salida;
}

/**
 * Pide permiso y registra el dispositivo. Tiene que llamarse desde un gesto del
 * usuario (un click): los navegadores rechazan el pedido de permiso si no.
 */
export async function activarPush(usuarioId: string, tenantId: string): Promise<void> {
  const clave = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  if (!clave) {
    // Sin claves, el push es un no-op silencioso. Mejor fallar fuerte acá que
    // dejar al usuario creyendo que activó algo que nunca va a llegar.
    throw new Error('Faltan las claves de notificaciones (VAPID). Avisale al equipo de SALA.');
  }

  const permiso = await Notification.requestPermission();
  if (permiso !== 'granted') {
    throw new Error('DENEGADO');
  }

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(clave) as unknown as BufferSource
  });

  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('La suscripción vino incompleta.');
  }

  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      tenant_id: tenantId,
      usuario_id: usuarioId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_agent: navigator.userAgent
    },
    { onConflict: 'endpoint' }
  );
  if (error) throw new Error(error.message);
}

/** Da de baja este dispositivo (no afecta a los demás del mismo usuario). */
export async function desactivarPush(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;

  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
}
