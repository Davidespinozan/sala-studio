import { supabase } from '@shared/lib/supabase';
import { MARKETING_DOMAIN } from '@shared/providers/TenantProvider';
import type { User } from '@supabase/supabase-js';

/**
 * Demo de SALA con SESIÓN ANÓNIMA: el visitante hace click en una vista y entra
 * a healthyspace con una identidad descartable creada al vuelo (Supabase anonymous
 * sign-in) — sin registrarse y sin que nadie cree cuentas. Un RPC le da el rol
 * elegido en healthyspace; la RLS + los guardrails lo encierran ahí (no puede tocar
 * otro gym ni la estructura). El reset nocturno limpia a los visitantes.
 *
 * Setup: activar "Allow anonymous sign-ins" en Supabase + VITE_DEMO_ENABLED=true.
 */
/** Vistas del demo. 'landing' es la página pública del gym (sin login); 'login'
 *  abre la pantalla de inicio de sesión con un socio de ejemplo pre-cargado; el
 *  resto son áreas con sesión (anónima). */
export type DemoVista = 'admin' | 'miembro' | 'recepcionista' | 'login' | 'landing';
type DemoRol = Exclude<DemoVista, 'landing' | 'login'>;

/** Credenciales del socio de ejemplo para "Vista login" (cuenta pública del demo,
 *  creada por migración en healthyspace). El login del tenant demo las pre-carga. */
export const DEMO_LOGIN = { email: 'demo@healthyspace.app', password: 'demo1234' };

export const DEMO_VISTAS: { rol: DemoVista; label: string; desc: string }[] = [
  { rol: 'admin', label: 'Vista admin', desc: 'El panel del dueño: reportes, socios, agenda y planes.' },
  { rol: 'miembro', label: 'Vista miembro', desc: 'La app del socio: reservar clases y tu QR de acceso.' },
  { rol: 'recepcionista', label: 'Vista recepción', desc: 'El check-in con QR y la lista del día.' },
  { rol: 'login', label: 'Vista login', desc: 'La pantalla de inicio de sesión, con un socio de ejemplo ya cargado.' },
  { rol: 'landing', label: 'Vista landing', desc: 'La página pública del gym: clases, planes y reservas.' }
];

const RUTA_POR_ROL: Record<DemoRol, string> = {
  admin: '/admin',
  miembro: '/app',
  recepcionista: '/recepcion'
};

/** Slug del tenant que sirve de demo público (su landing también es "modo demo"). */
export const DEMO_TENANT_SLUG = 'healthyspace';

/** ¿Está habilitado el demo? Gate del botón "Probar demo". */
export function demoDisponible(): boolean {
  return (import.meta.env.VITE_DEMO_ENABLED as string | undefined) === 'true';
}

/** ¿El tenant cargado es el del demo? (para mostrar el banner en su landing pública). */
export function esTenantDemo(slug: string | null | undefined): boolean {
  return demoDisponible() && slug === DEMO_TENANT_SLUG;
}

/** ¿La sesión actual es un visitante del demo (usuario anónimo)? */
export function esSesionDemo(authUser: User | null | undefined): boolean {
  return !!authUser?.is_anonymous;
}

/** Entra al demo en la vista elegida. 'landing' = página pública del subdominio
 *  de healthyspace (sin sesión). El resto = sesión anónima + provisión + hard-nav. */
export async function entrarAlDemo(vista: DemoVista): Promise<{ error: string | null }> {
  if (!demoDisponible()) return { error: 'El demo no está disponible.' };

  // Landing: es público. Si quedó una sesión demo previa (ej. entraste antes a
  // "Vista admin"), el landing del tenant te rebotaría a /admin por el role-
  // redirect. Cerramos la sesión primero para verlo realmente logged-out.
  if (vista === 'landing') {
    await supabase.auth.signOut().catch(() => {});
    window.location.href = `https://healthyspace.${MARKETING_DOMAIN}`;
    return { error: null };
  }

  // Login: PREVIEW del login personalizado del gym — solo para que vean cómo se
  // ve su pantalla de inicio de sesión con su marca. NO loguea. El flag
  // ?demo=login-preview evita que el role-redirect saque al visitante a /app si
  // quedó una sesión previa (ese era el "se logea automáticamente").
  if (vista === 'login') {
    await supabase.auth.signOut().catch(() => {});
    window.location.href = `https://healthyspace.${MARKETING_DOMAIN}/login?demo=login-preview`;
    return { error: null };
  }

  const { error: errAnon } = await supabase.auth.signInAnonymously();
  if (errAnon) return { error: errAnon.message };

  const { error: errProv } = await supabase.rpc('provisionar_demo' as never, { p_rol: vista } as never);
  if (errProv) return { error: (errProv as { message: string }).message };

  window.location.href = RUTA_POR_ROL[vista];
  return { error: null };
}
