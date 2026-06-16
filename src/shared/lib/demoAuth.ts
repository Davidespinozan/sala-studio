import { supabase } from '@shared/lib/supabase';
import { MARKETING_DOMAIN } from '@shared/providers/TenantProvider';
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
/** Vistas del demo. 'landing' es la página pública del gym (sin login); el resto
 *  son áreas con sesión (anónima). */
export type DemoVista = 'admin' | 'miembro' | 'recepcionista' | 'landing';
type DemoRol = Exclude<DemoVista, 'landing'>;

export const DEMO_VISTAS: { rol: DemoVista; label: string; desc: string }[] = [
  { rol: 'admin', label: 'Vista admin', desc: 'El panel del dueño: reportes, socios, agenda y planes.' },
  { rol: 'miembro', label: 'Vista miembro', desc: 'La app del socio: reservar clases y tu QR de acceso.' },
  { rol: 'recepcionista', label: 'Vista recepción', desc: 'El check-in con QR y la lista del día.' },
  { rol: 'landing', label: 'Vista landing', desc: 'La página pública del gym: clases, planes y reservas.' }
];

const RUTA_POR_ROL: Record<DemoRol, string> = {
  admin: '/admin',
  miembro: '/app',
  recepcionista: '/recepcion'
};

/** ¿Está habilitado el demo? Gate del botón "Probar demo". */
export function demoDisponible(): boolean {
  return (import.meta.env.VITE_DEMO_ENABLED as string | undefined) === 'true';
}

/** ¿La sesión actual es un visitante del demo (usuario anónimo)? */
export function esSesionDemo(authUser: User | null | undefined): boolean {
  return !!authUser?.is_anonymous;
}

/** Entra al demo en la vista elegida. 'landing' = página pública del subdominio
 *  de sala-demo (sin sesión). El resto = sesión anónima + provisión + hard-nav. */
export async function entrarAlDemo(vista: DemoVista): Promise<{ error: string | null }> {
  if (!demoDisponible()) return { error: 'El demo no está disponible.' };

  // Landing: es público, solo abrimos el subdominio de sala-demo.
  if (vista === 'landing') {
    window.location.href = `https://sala-demo.${MARKETING_DOMAIN}`;
    return { error: null };
  }

  const { error: errAnon } = await supabase.auth.signInAnonymously();
  if (errAnon) return { error: errAnon.message };

  const { error: errProv } = await supabase.rpc('provisionar_demo' as never, { p_rol: vista } as never);
  if (errProv) return { error: (errProv as { message: string }).message };

  window.location.href = RUTA_POR_ROL[vista];
  return { error: null };
}
