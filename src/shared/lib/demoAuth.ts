import { supabase } from '@shared/lib/supabase';

/**
 * Cuenta demo de SALA: un visitante entra a explorar sala-demo sin registrarse,
 * con auto-login a una cuenta compartida (admin de sala-demo). Las credenciales
 * viven en env (VITE_DEMO_EMAIL / VITE_DEMO_PASSWORD): son "públicas" por diseño
 * (van en el bundle), aceptable SOLO porque la RLS encierra todo en sala-demo —
 * no puede tocar ningún otro gym. Si las env no están, el demo no existe (el
 * botón no aparece).
 */
const DEMO_EMAIL = ((import.meta.env.VITE_DEMO_EMAIL as string | undefined) ?? '').trim().toLowerCase();
const DEMO_PASSWORD = (import.meta.env.VITE_DEMO_PASSWORD as string | undefined) ?? '';

/** ¿Está configurado el demo? Gate del botón "Probar demo". */
export function demoDisponible(): boolean {
  return DEMO_EMAIL.length > 0 && DEMO_PASSWORD.length > 0;
}

/** ¿La sesión/usuario actual es la cuenta demo? */
export function esSesionDemo(email: string | null | undefined): boolean {
  return DEMO_EMAIL.length > 0 && !!email && email.trim().toLowerCase() === DEMO_EMAIL;
}

/** Auto-login con la cuenta demo. */
export async function entrarAlDemo(): Promise<{ error: string | null }> {
  if (!demoDisponible()) return { error: 'El demo no está configurado.' };
  const { error } = await supabase.auth.signInWithPassword({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD
  });
  return { error: error?.message ?? null };
}
