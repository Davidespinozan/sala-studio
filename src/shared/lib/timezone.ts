/**
 * S4.4 — Multi-timezone. Cada tenant opera en su propia zona horaria.
 * La tz se guarda en tenant.config.timezone (jsonb). Las clases se almacenan
 * y muestran en la tz del gym — nunca en la del browser del miembro.
 */

import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { es } from 'date-fns/locale';

export const DEFAULT_TIMEZONE = 'America/Mexico_City';

/** Lee la timezone IANA del tenant desde config.timezone, con fallback. */
export function getTenantTimezone(
  tenant: { config?: unknown } | null | undefined
): string {
  const config = (tenant?.config ?? {}) as Record<string, unknown>;
  const tz = config.timezone;
  return typeof tz === 'string' && tz.length > 0 ? tz : DEFAULT_TIMEZONE;
}

// ---------------------------------------------------------------------------
// Helpers de fecha/hora conscientes de timezone
// ---------------------------------------------------------------------------

/** 'HH:MM:SS' o 'HH:MM' → 'HH:MM'. */
function trimSegundos(hora: string): string {
  return hora.length >= 5 ? hora.slice(0, 5) : hora;
}

/** 'YYYY-MM-DD' de hoy en la timezone dada (no la del browser). */
export function hoyEnTimezone(tz: string): string {
  return formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
}

/** Suma `dias` a una fecha 'YYYY-MM-DD' (aritmética de calendario exacta). */
export function sumarDias(fechaISO: string, dias: number): string {
  const [y, m, d] = fechaISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + dias));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** Días de calendario entre dos fechas 'YYYY-MM-DD' (b - a). */
export function diasEntre(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000
  );
}

/** Combina `fecha` ('YYYY-MM-DD') + `horaInicio` ('HH:MM[:SS]') interpretadas
 *  en `tz` y devuelve el instante UTC real (Date). */
export function instanteDeClase(fecha: string, horaInicio: string, tz: string): Date {
  return fromZonedTime(`${fecha}T${trimSegundos(horaInicio)}:00`, tz);
}

/** 'HH:MM' de un instante, en la timezone dada. */
export function formatHoraEnTz(instant: Date, tz: string): string {
  return formatInTimeZone(instant, tz, 'HH:mm');
}

/** Fecha larga en español: "lunes 25 de mayo". Recibe 'YYYY-MM-DD'. */
export function formatFechaLarga(fechaISO: string): string {
  const [y, m, d] = fechaISO.split('-').map(Number);
  // Mediodía local: solo se leen partes de fecha, sin riesgo de cruce de día.
  return formatInTimeZone(new Date(y, m - 1, d, 12), 'UTC', "EEEE d 'de' MMMM", {
    locale: es
  });
}

/** Etiqueta humana de una clase: "Hoy, 07:00" / "Mañana, 19:00" /
 *  "Lun 25 may, 07:00". `fecha`+`horaInicio` son wall-clock del gym. */
export function horaHumana(fecha: string, horaInicio: string, tz: string): string {
  const hhmm = trimSegundos(horaInicio);
  const hoy = hoyEnTimezone(tz);
  const manana = sumarDias(hoy, 1);
  if (fecha === hoy) return `Hoy, ${hhmm}`;
  if (fecha === manana) return `Mañana, ${hhmm}`;
  const [y, m, d] = fecha.split('-').map(Number);
  const corta = formatInTimeZone(new Date(y, m - 1, d, 12), 'UTC', 'EEE d MMM', {
    locale: es
  });
  const cap = corta.charAt(0).toUpperCase() + corta.slice(1);
  return `${cap}, ${hhmm}`;
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
