// ════════════════════════════════════════════════════════════════════════════
// Lógica pura del flujo de recuperación de contraseña
// ════════════════════════════════════════════════════════════════════════════
// Reusa las validaciones del onboarding (misma regla de password fuerte) y
// agrega lo propio del reset: coincidencia de contraseñas y traducción de
// errores de Supabase Auth. Sin React, sin red → testeable.
// ════════════════════════════════════════════════════════════════════════════

import { validarPassword, validarEmail, type ResultadoValidacion } from './onboardingLogic';

// Re-export: la pantalla "Recuperar contraseña" valida el email con la misma
// función que el onboarding.
export { validarEmail };
export type { ResultadoValidacion };

/**
 * Valida la contraseña nueva del reset: primero la fuerza (misma regla que el
 * signup del onboarding), después que ambas coincidan.
 */
export function validarNuevaContrasena(
  password: string,
  confirmacion: string
): ResultadoValidacion {
  const fuerza = validarPassword(password);
  if (!fuerza.ok) return fuerza;
  if (password !== confirmacion) {
    return { ok: false, error: 'Las contraseñas no coinciden.' };
  }
  return { ok: true };
}

/**
 * Traduce errores de Supabase Auth del flujo de recuperación a mensajes claros
 * en español. El caso clave es el enlace expirado/inválido.
 */
export function traducirErrorRecuperacion(message: string): string {
  const m = message.toLowerCase();
  if (
    m.includes('expired') ||
    m.includes('invalid') ||
    m.includes('not found') ||
    (m.includes('session') && m.includes('missing'))
  ) {
    return 'El enlace expiró o no es válido. Pedí uno nuevo.';
  }
  if (m.includes('different from the old') || m.includes('should be different')) {
    return 'La nueva contraseña debe ser distinta de la anterior.';
  }
  if (m.includes('weak') || m.includes('at least')) {
    return 'La contraseña no es lo bastante fuerte.';
  }
  if (m.includes('too many') || m.includes('rate')) {
    return 'Demasiados intentos. Esperá unos minutos.';
  }
  // Genérico en español: no exponer el mensaje crudo de Supabase (inglés).
  return 'No pudimos completar la acción. Intentá de nuevo.';
}
