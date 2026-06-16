import { supabase } from '@shared/lib/supabase';
import type { User } from '@supabase/supabase-js';

/**
 * Demo de SALA con SESIÓN ANÓNIMA: el visitante hace click en una vista y entra
 * a sala-demo con una identidad descartable creada al vuelo (Supabase anonymous
 * sign-in) — sin registrarse y sin que nadie cree cuentas. Un RPC le da el rol
 * elegido en sala-demo; la RLS + los guardrails lo encierran ahí (no puede tocar
 * otro gym ni la estructura). El reset nocturno limpia a los visitantes.
 *
 * Setup: activar "Allow anonymous sign-ins" en Supabase + VITE_DEMO_ENABLED=true.
 */
export type DemoRol = 'admin' | 'miembro' | 'recepcionista';

export const DEMO_VISTAS: { rol: DemoRol; label: string; desc: string; ruta: string }[] = [
  { rol: 'admin', label: 'Vista admin', desc: 'El panel del dueño: reportes, socios, agenda y planes.', ruta: '/admin' },
  { rol: 'miembro', label: 'Vista miembro', desc: 'La app del socio: reservar clases y tu QR de acceso.', ruta: '/app' },
  { rol: 'recepcionista', label: 'Vista recepción', desc: 'El check-in con QR y la lista del día.', ruta: '/recepcion' }
];

/** ¿Está habilitado el demo? Gate del botón "Probar demo". */
export function demoDisponible(): boolean {
  return (import.meta.env.VITE_DEMO_ENABLED as string | undefined) === 'true';
}

/** ¿La sesión actual es un visitante del demo (usuario anónimo)? */
export function esSesionDemo(authUser: User | null | undefined): boolean {
  return !!authUser?.is_anonymous;
}

/** Entra al demo en el rol elegido: sesión anónima + provisión + hard-nav. */
export async function entrarAlDemo(rol: DemoRol): Promise<{ error: string | null }> {
  if (!demoDisponible()) return { error: 'El demo no está disponible.' };

  const { error: errAnon } = await supabase.auth.signInAnonymously();
  if (errAnon) return { error: errAnon.message };

  const { error: errProv } = await supabase.rpc('provisionar_demo' as never, { p_rol: rol } as never);
  if (errProv) return { error: (errProv as { message: string }).message };

  const ruta = DEMO_VISTAS.find((v) => v.rol === rol)?.ruta ?? '/admin';
  window.location.href = ruta;
  return { error: null };
}
