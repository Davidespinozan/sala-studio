/**
 * Adapter: convierte una fila real de `clases` (con su recurso joineado y el
 * count de reservas activas) en la interfaz `Clase` que consume la UI.
 *
 * Hasta S4.1 esta capa mockeaba cupos e instructores porque no había tabla
 * real. Desde S4.2 lee de `clases` directamente — los mocks viejos
 * (CUPO_MAX_MOCK, MOCK_INSTRUCTORES, mockInstructorFor, clasesDelDia,
 * reservaToClase) fueron eliminados. El instructor sale del JOIN a la tabla
 * `instructores` (S6).
 */

import {
  instanteDeClase,
  formatHoraEnTz,
  formatFechaLarga,
  horaHumana
} from '@shared/lib/timezone';
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
  /** FK a instructores. null si la clase no tiene instructor asignado. */
  instructorId: string | null;
  /** Nombre del instructor asignado (del JOIN a instructores). undefined si no hay. */
  instructorNombre?: string;
  /** Foto del instructor asignado. */
  instructorFotoUrl?: string;
  /** Bio del instructor asignado. */
  instructorBio?: string;
  disciplina: string;
  descripcion?: string;
  imagenUrl?: string;
  /** Nombre de la sala física donde se da la clase. */
  salaNombre?: string;
  /** Tier slugs permitidos (vienen del recurso). */
  tiersPermitidos?: string[];
  /** Estado de la clase: 'programada' | 'cancelada' | 'completada'. */
  status: string;
  /** Timestamp ISO de cancelación, si la clase fue cancelada. */
  canceladaAt: string | null;
  // ── Fecha/hora (S4.4: todo en la timezone del tenant) ──
  /** Fecha de la clase 'YYYY-MM-DD' (wall-clock del gym = clases.fecha). */
  fechaISO: string;
  /** Hora de inicio 'HH:MM' (wall-clock del gym). */
  horaLabel: string;
  /** Fecha larga: "lunes 25 de mayo". */
  fechaLabel: string;
  /** Etiqueta humana: "Hoy, 07:00" / "Mañana, 19:00" / "Lun 25 may, 07:00". */
  horaHumanaLabel: string;
  /** slotInicio / slotFin: instantes UTC reales (para comparar contra now). */
  slotInicio: Date;
  slotFin: Date;
  // Datos brutos para navegación / acciones
  recursoId: string;
}

export interface RecursoContext {
  id: string;
  nombre: string;
  foto_url?: string | null;
  tiers_permitidos?: string[];
}

// ---------------------------------------------------------------------------
// Mapper principal
// ---------------------------------------------------------------------------

/** Instructor joineado desde la tabla `instructores` (S6). */
export interface InstructorContext {
  id: string;
  nombre: string;
  foto_url: string | null;
  bio?: string | null;
}

interface ClaseFromRowInput {
  row: ClaseRow;
  cuposReservados: number;
  recurso: RecursoContext;
  /** Instructor del JOIN. null/undefined si la clase no tiene instructor. */
  instructor?: InstructorContext | null;
  /** Timezone del tenant (S4.4). Las clases se interpretan/muestran en ella. */
  tz: string;
}

/** Construye la Clase UI desde una fila real de `clases` + recurso + count.
 *  S4.4: slotInicio/slotFin son instantes UTC reales (calculados con la tz
 *  del tenant); las labels de fecha/hora se precomputan en esa tz. */
export function claseFromRow({
  row,
  cuposReservados,
  recurso,
  instructor,
  tz
}: ClaseFromRowInput): Clase {
  const slotInicio = instanteDeClase(row.fecha, row.hora_inicio, tz);
  const slotFin = new Date(slotInicio.getTime() + row.duracion_minutos * 60_000);
  return {
    id: row.id,
    nombre: row.nombre,
    hora: slotInicio.toISOString(),
    duracionMinutos: row.duracion_minutos,
    cupoMax: row.cupo_max,
    cuposReservados,
    instructorId: row.instructor_id,
    instructorNombre: instructor?.nombre,
    instructorFotoUrl: instructor?.foto_url ?? undefined,
    instructorBio: instructor?.bio ?? undefined,
    disciplina: row.disciplina ?? '',
    descripcion: row.descripcion ?? undefined,
    imagenUrl: recurso.foto_url ?? undefined,
    salaNombre: recurso.nombre,
    tiersPermitidos: recurso.tiers_permitidos,
    status: row.status,
    canceladaAt: row.cancelada_at,
    fechaISO: row.fecha,
    horaLabel: formatHoraEnTz(slotInicio, tz),
    fechaLabel: formatFechaLarga(row.fecha),
    horaHumanaLabel: horaHumana(row.fecha, row.hora_inicio, tz),
    slotInicio,
    slotFin,
    recursoId: row.recurso_id
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
