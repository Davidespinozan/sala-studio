/**
 * Adapter: convierte una fila real de `clases` (con su recurso joineado y el
 * count de reservas activas) en la interfaz `Clase` que consume la UI.
 *
 * Hasta S4.1 esta capa mockeaba cupos e instructores porque no había tabla
 * real. Desde S4.2 lee de `clases` directamente — los mocks viejos
 * (CUPO_MAX_MOCK, MOCK_INSTRUCTORES, mockInstructorFor, clasesDelDia,
 * reservaToClase) fueron eliminados.
 *
 * `instructor_nombre_mock` sigue siendo el placeholder hasta que llegue la
 * tabla `instructores` (Sprint S6).
 */

import { combinarFechaHora } from './reservaLogic';
import type { Database } from '@shared/types/database';

type ClaseRow = Database['public']['Tables']['clases']['Row'];

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface Clase {
  /** UUID real de la fila en `clases` (era ID composite recursoId_slotISO antes de S4.2). */
  id: string;
  nombre: string;
  /** ISO datetime del inicio de la clase (en zona horaria local del browser). */
  hora: string;
  duracionMinutos: number;
  cupoMax: number;
  cuposReservados: number;
  instructor: string;
  disciplina: string;
  descripcion?: string;
  imagenUrl?: string;
  /** Nombre de la sala física donde se da la clase. */
  salaNombre?: string;
  /** Tier slugs permitidos (vienen del recurso). */
  tiersPermitidos?: string[];
  // Datos brutos para navegación / acciones
  recursoId: string;
  slotInicio: Date;
  slotFin: Date;
}

export interface RecursoContext {
  id: string;
  nombre: string;
  foto_url?: string | null;
  tiers_permitidos?: string[];
}

// ---------------------------------------------------------------------------
// Helpers de combinación fecha+hora
// ---------------------------------------------------------------------------

/** Postgres `time` viene como 'HH:MM:SS'. La UI usa 'HH:MM'. */
function trimSegundos(horaStr: string): string {
  return horaStr.length >= 5 ? horaStr.slice(0, 5) : horaStr;
}

/** Combina `clases.fecha` ('YYYY-MM-DD') + `clases.hora_inicio` ('HH:MM:SS')
 *  en un Date local (timezone del browser). */
export function slotInicioFromClaseRow(row: Pick<ClaseRow, 'fecha' | 'hora_inicio'>): Date {
  return combinarFechaHora(row.fecha, trimSegundos(row.hora_inicio));
}

// ---------------------------------------------------------------------------
// Mapper principal
// ---------------------------------------------------------------------------

interface ClaseFromRowInput {
  row: ClaseRow;
  cuposReservados: number;
  recurso: RecursoContext;
}

/** Construye la Clase UI desde una fila real de `clases` + recurso + count. */
export function claseFromRow({ row, cuposReservados, recurso }: ClaseFromRowInput): Clase {
  const slotInicio = slotInicioFromClaseRow(row);
  const slotFin = new Date(slotInicio.getTime() + row.duracion_minutos * 60_000);
  return {
    id: row.id,
    nombre: row.nombre,
    hora: slotInicio.toISOString(),
    duracionMinutos: row.duracion_minutos,
    cupoMax: row.cupo_max,
    cuposReservados,
    instructor: row.instructor_nombre_mock ?? 'Por confirmar',
    disciplina: row.disciplina ?? '',
    descripcion: row.descripcion ?? undefined,
    imagenUrl: recurso.foto_url ?? undefined,
    salaNombre: recurso.nombre,
    tiersPermitidos: recurso.tiers_permitidos,
    recursoId: row.recurso_id,
    slotInicio,
    slotFin
  };
}

// ---------------------------------------------------------------------------
// Helpers de etiquetado UI
// ---------------------------------------------------------------------------

/** Categoriza el estado de cupos de una clase para decidir color/tono. */
export type EstadoCupos = 'disponible' | 'pocos' | 'llena';

export function estadoCupos(clase: Clase): EstadoCupos {
  const libres = clase.cupoMax - clase.cuposReservados;
  if (libres <= 0) return 'llena';
  if (libres <= 3) return 'pocos';
  return 'disponible';
}

/** Formato humano para la hora de una clase: "Hoy, 7:00 AM" / "Mañana, 19:00" / "Lun 25 may, 8:00". */
export function formatHoraHumana(slot: Date, ahora: Date = new Date()): string {
  const hoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const manana = new Date(hoy);
  manana.setDate(hoy.getDate() + 1);
  const slotDia = new Date(slot.getFullYear(), slot.getMonth(), slot.getDate());

  const horaStr = slot.toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  if (slotDia.getTime() === hoy.getTime()) return `Hoy, ${horaStr}`;
  if (slotDia.getTime() === manana.getTime()) return `Mañana, ${horaStr}`;

  const dia = slot.toLocaleDateString('es-MX', { weekday: 'short' });
  const num = slot.getDate();
  const mes = slot.toLocaleDateString('es-MX', { month: 'short' });
  const diaCap = dia.charAt(0).toUpperCase() + dia.slice(1);
  return `${diaCap} ${num} ${mes}, ${horaStr}`;
}
