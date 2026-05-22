/**
 * Lógica pura de reservas. Sin React, sin Supabase. Testeable.
 * Helpers de fecha y filtrado que usan las pantallas de reserva del miembro.
 */

import type { Database } from '@shared/types/database';
import { hoyEnTimezone, sumarDias } from '@shared/lib/timezone';

type Recurso = Database['public']['Tables']['recursos']['Row'];

export interface TenantReservaConfig {
  duracion_default_min: number;
  cupos_por_recurso: number;
  permitir_continuas: boolean;
  anticipacion_min_horas: number;
  anticipacion_max_dias: number;
  ventana_check_in_min: number;
}

const DIAS_ES = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'] as const;

/**
 * Convierte el día de una fecha (0-6 con domingo=0) a nombre en español
 * sin tildes, matcheando lo que viene en recursos.horarios.
 */
export function diaNombre(date: Date): string {
  return DIAS_ES[date.getDay()];
}

/**
 * Combina una fecha (YYYY-MM-DD) con una hora (HH:mm) en zona horaria local.
 * IMPORTANTE: crea Date en local time, no UTC.
 */
export function combinarFechaHora(fechaISO: string, horaHHmm: string): Date {
  const [y, m, d] = fechaISO.split('-').map(Number);
  const [h, min] = horaHHmm.split(':').map(Number);
  return new Date(y, m - 1, d, h, min, 0, 0);
}

/**
 * Genera la lista de fechas reservables a partir de hoy según anticipación_max_dias.
 * S4.4: "hoy" se calcula en la timezone del tenant (`tz`), no en la del browser.
 */
export function generarFechasReservables(
  config: TenantReservaConfig,
  tz: string
): { fechaISO: string; date: Date; label: string }[] {
  const fechas: { fechaISO: string; date: Date; label: string }[] = [];
  const hoy = hoyEnTimezone(tz);
  const manana = sumarDias(hoy, 1);

  for (let i = 0; i < config.anticipacion_max_dias; i++) {
    const fechaISO = sumarDias(hoy, i);
    const [y, m, d] = fechaISO.split('-').map(Number);
    // Date a mediodía local: solo se leen partes de calendario (día, mes, dow).
    const date = new Date(y, m - 1, d, 12);
    let label: string;
    if (fechaISO === hoy) {
      label = 'Hoy';
    } else if (fechaISO === manana) {
      label = 'Mañana';
    } else {
      const dia = DIAS_ES[date.getDay()];
      const mes = date.toLocaleDateString('es-MX', { month: 'short' });
      label = `${capitalize(dia)} ${d} ${mes}`;
    }
    fechas.push({ fechaISO, date, label });
  }

  return fechas;
}

/**
 * Filtra recursos accesibles según el tier del usuario.
 */
export function filtrarRecursosPorTier(
  recursos: Recurso[],
  membresia_tier: string | null
): Recurso[] {
  if (!membresia_tier) return recursos.filter((r) => r.tiers_permitidos.length === 0);
  return recursos.filter((r) => r.tiers_permitidos.includes(membresia_tier));
}

/**
 * Formato YYYY-MM-DD en local time (no UTC).
 */
export function formatDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Label legible para selector de fecha.
 */
export function formatDateLabel(d: Date, ahora: Date = new Date()): string {
  const hoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const manana = new Date(hoy);
  manana.setDate(hoy.getDate() + 1);

  if (sameDay(d, hoy)) return 'Hoy';
  if (sameDay(d, manana)) return 'Mañana';

  const dia = DIAS_ES[d.getDay()];
  const num = d.getDate();
  const mes = d.toLocaleDateString('es-MX', { month: 'short' });
  return `${capitalize(dia)} ${num} ${mes}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Formato HH:mm para mostrar hora.
 */
export function formatHora(d: Date): string {
  return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Traduce los códigos de error de los RPC de reservas a mensajes user-friendly.
 */
export function traducirErrorRPC(message: string): string {
  if (message.includes('USUARIO_INACTIVO')) return 'Tu membresía no está activa. Contactá al administrador.';
  if (message.includes('USUARIO_BLOQUEADO')) return 'Tu cuenta tiene una restricción activa.';
  if (message.includes('RECURSO_NO_EXISTE')) return 'Esta sala no está disponible.';
  if (message.includes('RECURSO_INACTIVO')) return 'Esta sala no está disponible.';
  if (message.includes('TIER_NO_PERMITIDO')) return 'Tu plan no tiene acceso a esta sala.';
  if (message.includes('TIER_NO_PERMITE')) return 'Tu plan no incluye acceso a esta sala.';
  if (message.includes('INVITADOS_EXCEDEN')) return 'Tu plan no permite tantos invitados.';
  if (message.includes('INVITADOS_INVALIDOS')) return 'Número de invitados inválido.';
  if (message.includes('ANTICIPACION_INSUFICIENTE')) return 'Necesitás reservar con más anticipación.';
  if (message.includes('ANTICIPACION_EXCESIVA')) return 'No podés reservar tan lejos en el futuro.';
  if (message.includes('CONTINUAS_NO_PERMITIDAS')) return 'No podés reservar horas consecutivas.';
  if (message.includes('CONTINUA')) return 'No podés reservar horas consecutivas.';
  if (message.includes('SLOT_OCUPADO')) return 'Este horario acaba de ser tomado por otro miembro. Elegí otro.';
  if (message.includes('CLASE_NO_EXISTE')) return 'Esta clase no existe en tu gimnasio.';
  if (message.includes('CLASE_NO_PROGRAMADA')) return 'Esta clase ya no está disponible.';
  if (message.includes('YA_RESERVADO')) return 'Ya tenés una reserva activa en esta clase.';
  if (message.includes('CUPO_LLENO')) return 'Esta clase está llena. Probá con otro horario.';
  if (message.includes('RESERVA_NO_EXISTE')) return 'No encontramos esa reserva.';
  if (message.includes('NO_AUTORIZADO')) return 'No podés hacer esta acción.';
  if (message.includes('RESERVA_NO_CANCELABLE')) return 'Esta reserva no se puede cancelar.';
  if (message.includes('RESERVA_PASADA')) return 'No podés cancelar una reserva que ya pasó.';
  if (message.includes('YA_EN_LISTA')) return 'Ya estás en la lista de espera de esta clase.';
  if (message.includes('NO_EN_LISTA')) return 'No estás en la lista de espera de esta clase.';
  if (message.includes('HAY_CUPO')) return 'Esta clase tiene lugares disponibles, reservá normalmente.';
  if (message.includes('CLASE_PASADA')) return 'Esta clase ya empezó.';
  if (message.includes('YA_PROCESADA')) return 'Esa persona ya no está en la lista de espera.';
  if (message.includes('ENTRADA_NO_EXISTE')) return 'No encontramos esa entrada de lista de espera.';
  return message;
}
