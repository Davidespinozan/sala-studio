/**
 * Adapter: convierte (recurso, slot, reservas) → Clase visual.
 *
 * Hoy SALA usa el modelo EKKO (recursos + slots virtuales). Esta capa
 * presenta los datos al UI como "clases de gimnasio" con cupos, instructor
 * y disciplina, MOCKEANDO los campos que todavía no existen en BD.
 *
 * Cuando llegue S4 y se cree la tabla `clases` real, los componentes de
 * UI siguen funcionando — solo se reescribe este archivo para mapear de
 * la nueva tabla en lugar de mockear.
 */

import { diaNombre, combinarFechaHora, type HorarioBloque } from './reservaLogic';

// ---------------------------------------------------------------------------
// Mocks centralizados — TODO S4: reemplazar por datos reales de tabla `clases`
// ---------------------------------------------------------------------------

const CUPO_MAX_MOCK = 20;
const MOCK_INSTRUCTORES = ['María', 'Carlos', 'Sofía', 'Diego', 'Lucía', 'Pablo'];

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface Clase {
  /** ID compuesto recursoId_slotISO. En S4 será UUID propio. */
  id: string;
  nombre: string;
  /** ISO datetime del inicio del slot. */
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
  /** Tier slugs permitidos para reservar (de recurso.tiers_permitidos). */
  tiersPermitidos?: string[];
  // Datos brutos para navegación / acciones
  recursoId: string;
  slotInicio: Date;
  slotFin: Date;
}

export interface RecursoMin {
  id: string;
  nombre: string;
  descripcion?: string | null;
  foto_url?: string | null;
  tipo_contenido?: string[] | null;
  tiers_permitidos?: string[];
  horarios?: unknown;
}

// ---------------------------------------------------------------------------
// ID composite (encode/decode)
// ---------------------------------------------------------------------------

export function makeClaseId(recursoId: string, slotInicio: Date): string {
  return `${recursoId}_${slotInicio.toISOString()}`;
}

export function parseClaseId(id: string): { recursoId: string; slotInicio: Date } | null {
  const idx = id.indexOf('_');
  if (idx === -1) return null;
  const recursoId = id.slice(0, idx);
  const slotISO = id.slice(idx + 1);
  const slotInicio = new Date(slotISO);
  if (!recursoId || isNaN(slotInicio.getTime())) return null;
  return { recursoId, slotInicio };
}

// ---------------------------------------------------------------------------
// Mocks deterministas
// ---------------------------------------------------------------------------

/** Instructor mock derivado del hash de (recursoId + slotISO).
 *  Determinista: misma clase, mismo instructor entre renders.
 *  TODO S4: leer de tabla clases.instructor_id → usuarios.nombre */
function mockInstructorFor(recursoId: string, slotISO: string): string {
  const seed = (recursoId + slotISO).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return MOCK_INSTRUCTORES[seed % MOCK_INSTRUCTORES.length];
}

/** Disciplina derivada del primer tipo_contenido del recurso, o cae al nombre.
 *  TODO S4: campo `disciplina` real en tabla clases */
function disciplinaFor(recurso: RecursoMin): string {
  const tag = recurso.tipo_contenido?.[0];
  if (tag) return tag;
  return recurso.nombre;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

interface ToClaseInput {
  recurso: RecursoMin;
  slotInicio: Date;
  duracionMinutos: number;
  cuposReservados: number;
}

function toClase(input: ToClaseInput): Clase {
  const slotFin = new Date(input.slotInicio.getTime() + input.duracionMinutos * 60_000);
  const slotISO = input.slotInicio.toISOString();
  return {
    id: makeClaseId(input.recurso.id, input.slotInicio),
    nombre: input.recurso.nombre,
    hora: slotISO,
    duracionMinutos: input.duracionMinutos,
    cupoMax: CUPO_MAX_MOCK,
    cuposReservados: input.cuposReservados,
    instructor: mockInstructorFor(input.recurso.id, slotISO),
    disciplina: disciplinaFor(input.recurso),
    descripcion: input.recurso.descripcion ?? undefined,
    imagenUrl: input.recurso.foto_url ?? undefined,
    salaNombre: input.recurso.nombre,
    tiersPermitidos: input.recurso.tiers_permitidos,
    recursoId: input.recurso.id,
    slotInicio: input.slotInicio,
    slotFin
  };
}

/** Genera los slots base de un recurso para una fecha (sin marcar disponibilidad).
 *  Es una versión "neutral" de generarSlotsDisponibles para uso del adapter. */
function generarSlotsBase(
  horarios: HorarioBloque[],
  fechaISO: string,
  duracionMin: number
): Date[] {
  const fechaBase = new Date(fechaISO + 'T00:00:00');
  const diaSemana = diaNombre(fechaBase);
  const bloquesDia = horarios.filter((b) => b.dia === diaSemana);
  if (bloquesDia.length === 0) return [];

  const slots: Date[] = [];
  for (const bloque of bloquesDia) {
    const inicioBloque = combinarFechaHora(fechaISO, bloque.inicio);
    const finBloque = combinarFechaHora(fechaISO, bloque.fin);
    let cursor = new Date(inicioBloque);
    while (cursor.getTime() + duracionMin * 60_000 <= finBloque.getTime()) {
      slots.push(new Date(cursor));
      cursor = new Date(cursor.getTime() + duracionMin * 60_000);
    }
  }
  return slots;
}

/** Genera todas las Clases de un día, atravesando todos los recursos activos.
 *  Sort por hora ascendente.
 *
 *  @param reservasExistentes filas crudas de `reservas` con recurso_id +
 *         slot_inicio (en status 'confirmada' o 'completada') usadas para
 *         calcular cuposReservados.
 */
export function clasesDelDia(
  recursos: RecursoMin[],
  fechaISO: string,
  duracionDefaultMin: number,
  reservasExistentes: Array<{ recurso_id: string; slot_inicio: string }>
): Clase[] {
  // Index reservas por (recurso_id + slot_inicio_ms) → count
  const cuposMap = new Map<string, number>();
  for (const r of reservasExistentes) {
    const ms = new Date(r.slot_inicio).getTime();
    const key = `${r.recurso_id}_${ms}`;
    cuposMap.set(key, (cuposMap.get(key) ?? 0) + 1);
  }

  const clases: Clase[] = [];
  for (const recurso of recursos) {
    const horarios = (recurso.horarios as HorarioBloque[] | null | undefined) ?? [];
    const slots = generarSlotsBase(horarios, fechaISO, duracionDefaultMin);
    for (const slot of slots) {
      const key = `${recurso.id}_${slot.getTime()}`;
      clases.push(toClase({
        recurso,
        slotInicio: slot,
        duracionMinutos: duracionDefaultMin,
        cuposReservados: cuposMap.get(key) ?? 0
      }));
    }
  }

  clases.sort((a, b) => a.slotInicio.getTime() - b.slotInicio.getTime());
  return clases;
}

/** Convierte una reserva existente del miembro + el recurso joined en una Clase.
 *  Útil para "próxima clase" del Dashboard o detalle de clase ya reservada. */
export function reservaToClase(
  reserva: { recurso_id: string; slot_inicio: string; slot_fin: string },
  recurso: RecursoMin,
  cuposReservadosTotales?: number
): Clase {
  const slotInicio = new Date(reserva.slot_inicio);
  const slotFin = new Date(reserva.slot_fin);
  const duracionMin = Math.max(1, Math.round((slotFin.getTime() - slotInicio.getTime()) / 60_000));
  return toClase({
    recurso,
    slotInicio,
    duracionMinutos: duracionMin,
    // Si el caller no provee count, asumimos al menos 1 (el propio miembro).
    // TODO S4: pasar el count real siempre.
    cuposReservados: cuposReservadosTotales ?? 1
  });
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
  // Capitalizar primera letra del día
  const diaCap = dia.charAt(0).toUpperCase() + dia.slice(1);
  return `${diaCap} ${num} ${mes}, ${horaStr}`;
}
