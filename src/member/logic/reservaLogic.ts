/**
 * Lógica pura de reservas. Sin React, sin Supabase.
 * Testeable. Toda la lógica del cliente que decide qué mostrar/permitir.
 *
 * NOTA: la fuente de verdad sigue siendo el RPC `reservar_recurso_atomic`.
 * Esta capa cliente es solo para UX (no mostrar slots inválidos al usuario).
 */

import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];
type Reserva = Database['public']['Tables']['reservas']['Row'];

export interface Slot {
  inicio: Date;
  fin: Date;
  disponible: boolean;
  razon?: 'ocupado' | 'pasado' | 'anticipacion_insuficiente' | 'continuo' | 'fuera_horario';
}

export interface HorarioBloque {
  dia: string;        // 'lunes' | 'martes' | ... | 'domingo'
  inicio: string;     // 'HH:mm' ej '09:00'
  fin: string;        // 'HH:mm' ej '22:00'
}

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
 * Genera los slots disponibles para un recurso en una fecha específica.
 *
 * Considera:
 * - Horario del recurso (recursos.horarios) para ese día de semana
 * - Reservas ya activas en ese recurso (no disponibles)
 * - Anticipación mínima del tenant (no reservar muy cerca)
 * - Reservas continuas del propio usuario (si tenant prohíbe continuas)
 *
 * @param recurso El recurso seleccionado
 * @param fechaISO Fecha objetivo en formato 'YYYY-MM-DD'
 * @param config Reglas del tenant
 * @param reservasDelRecurso Reservas ya activas en ese recurso (cualquier usuario)
 * @param reservasDelUsuario Reservas ya activas del usuario (cualquier recurso) — para regla continuas
 * @param ahora Fecha actual (inyectable para testing)
 */
export function generarSlotsDisponibles(
  recurso: Recurso,
  fechaISO: string,
  config: TenantReservaConfig,
  reservasDelRecurso: Pick<Reserva, 'slot_inicio'>[],
  reservasDelUsuario: Pick<Reserva, 'slot_inicio'>[],
  ahora: Date = new Date()
): Slot[] {
  const horarios = (recurso.horarios as unknown as HorarioBloque[]) ?? [];
  const fechaBase = new Date(fechaISO + 'T00:00:00');
  const diaSemana = diaNombre(fechaBase);

  // Encontrar bloques de horario para ese día
  const bloquesDia = horarios.filter((b) => b.dia === diaSemana);
  if (bloquesDia.length === 0) return [];

  const slots: Slot[] = [];
  const duracion = config.duracion_default_min;
  const anticipacionMs = config.anticipacion_min_horas * 60 * 60 * 1000;
  const limiteAnticipacion = new Date(ahora.getTime() + anticipacionMs);

  // Set de slots ocupados (timestamps ISO) para lookup O(1)
  const ocupados = new Set(reservasDelRecurso.map((r) => new Date(r.slot_inicio).getTime()));

  // Set de slots del usuario (para detectar continuos si está prohibido)
  const slotsUsuario = new Set(reservasDelUsuario.map((r) => new Date(r.slot_inicio).getTime()));

  for (const bloque of bloquesDia) {
    const inicioBloque = combinarFechaHora(fechaISO, bloque.inicio);
    const finBloque = combinarFechaHora(fechaISO, bloque.fin);

    let cursor = new Date(inicioBloque);
    while (cursor.getTime() + duracion * 60_000 <= finBloque.getTime()) {
      const slotInicio = new Date(cursor);
      const slotFin = new Date(cursor.getTime() + duracion * 60_000);
      const slotInicioMs = slotInicio.getTime();

      let disponible = true;
      let razon: Slot['razon'] | undefined;

      if (slotInicio < ahora) {
        disponible = false;
        razon = 'pasado';
      } else if (slotInicio < limiteAnticipacion) {
        disponible = false;
        razon = 'anticipacion_insuficiente';
      } else if (ocupados.has(slotInicioMs)) {
        disponible = false;
        razon = 'ocupado';
      } else if (!config.permitir_continuas) {
        // Validar que el usuario no tenga reserva en slot adyacente (±duracion)
        const slotAnteriorMs = slotInicioMs - duracion * 60_000;
        const slotSiguienteMs = slotInicioMs + duracion * 60_000;
        if (slotsUsuario.has(slotAnteriorMs) || slotsUsuario.has(slotSiguienteMs)) {
          disponible = false;
          razon = 'continuo';
        }
      }

      slots.push({ inicio: slotInicio, fin: slotFin, disponible, razon });

      // Avanzar al siguiente slot (duración + 0 gap)
      cursor = new Date(cursor.getTime() + duracion * 60_000);
    }
  }

  return slots;
}

/**
 * Genera la lista de fechas reservables a partir de hoy según anticipación_max_dias.
 */
export function generarFechasReservables(
  config: TenantReservaConfig,
  ahora: Date = new Date()
): { fechaISO: string; date: Date; label: string }[] {
  const fechas: { fechaISO: string; date: Date; label: string }[] = [];
  const hoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());

  for (let i = 0; i < config.anticipacion_max_dias; i++) {
    const d = new Date(hoy);
    d.setDate(hoy.getDate() + i);
    const fechaISO = formatDateISO(d);
    fechas.push({
      fechaISO,
      date: d,
      label: formatDateLabel(d, ahora)
    });
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
 * Traduce errores del RPC reservar_recurso_atomic a mensajes user-friendly.
 */
export function traducirErrorRPC(message: string): string {
  if (message.includes('EKKO_USUARIO_INACTIVO')) return 'Tu membresía no está activa. Contacta al administrador.';
  if (message.includes('EKKO_USUARIO_BLOQUEADO')) return 'Tu cuenta tiene una restricción activa.';
  if (message.includes('EKKO_RECURSO_NO_EXISTE')) return 'El estudio no está disponible.';
  if (message.includes('EKKO_RECURSO_INACTIVO')) return 'Este estudio no está disponible.';
  if (message.includes('EKKO_TIER_NO_PERMITIDO')) return 'Tu plan no tiene acceso a este estudio.';
  if (message.includes('EKKO_TIER_NO_PERMITE')) return 'Tu plan no incluye acceso a este estudio.';
  if (message.includes('EKKO_INVITADOS_EXCEDEN')) return 'Tu plan no permite tantos invitados.';
  if (message.includes('EKKO_INVITADOS_INVALIDOS')) return 'Número de invitados inválido.';
  if (message.includes('EKKO_ANTICIPACION_INSUFICIENTE')) return 'Necesitas reservar con más anticipación.';
  if (message.includes('EKKO_ANTICIPACION_EXCESIVA')) return 'No puedes reservar tan lejos en el futuro.';
  if (message.includes('EKKO_CONTINUAS_NO_PERMITIDAS')) return 'No puedes reservar horas consecutivas.';
  if (message.includes('EKKO_CONTINUA')) return 'No puedes reservar horas consecutivas.';
  if (message.includes('EKKO_SLOT_OCUPADO')) return 'Este horario acaba de ser tomado por otro miembro. Elige otro.';
  if (message.includes('EKKO_RESERVA_NO_EXISTE')) return 'La reserva no existe.';
  if (message.includes('EKKO_NO_AUTORIZADO')) return 'No puedes hacer esta acción.';
  if (message.includes('EKKO_RESERVA_NO_CANCELABLE')) return 'Esta reserva no se puede cancelar.';
  if (message.includes('EKKO_RESERVA_PASADA')) return 'No puedes cancelar una reserva que ya pasó.';
  return message;
}
