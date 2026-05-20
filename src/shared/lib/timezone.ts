/**
 * S4.4 — Multi-timezone. Cada tenant opera en su propia zona horaria.
 * La tz se guarda en tenant.config.timezone (jsonb). Las clases se almacenan
 * y muestran en la tz del gym — nunca en la del browser del miembro.
 */

export const DEFAULT_TIMEZONE = 'America/Mexico_City';

/** Lee la timezone IANA del tenant desde config.timezone, con fallback. */
export function getTenantTimezone(
  tenant: { config?: unknown } | null | undefined
): string {
  const config = (tenant?.config ?? {}) as Record<string, unknown>;
  const tz = config.timezone;
  return typeof tz === 'string' && tz.length > 0 ? tz : DEFAULT_TIMEZONE;
}

/** Opciones de timezone para el selector del admin. */
export const TIMEZONE_OPTIONS: { value: string; label: string }[] = [
  { value: 'America/Mexico_City', label: 'CDMX, Guadalajara (GMT-6)' },
  { value: 'America/Mazatlan', label: 'Sinaloa, Mazatlán (GMT-7)' },
  { value: 'America/Tijuana', label: 'Tijuana, Baja California (GMT-8)' },
  { value: 'America/Cancun', label: 'Cancún, Quintana Roo (GMT-5)' },
  { value: 'America/Bogota', label: 'Colombia (GMT-5)' },
  { value: 'America/Lima', label: 'Perú (GMT-5)' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Argentina (GMT-3)' },
  { value: 'America/Santiago', label: 'Chile (GMT-4/-3)' },
  { value: 'America/New_York', label: 'USA Este (GMT-5/-4)' },
  { value: 'America/Los_Angeles', label: 'USA Oeste (GMT-8/-7)' },
  { value: 'Europe/Madrid', label: 'España (GMT+1/+2)' }
];
