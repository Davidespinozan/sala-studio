/**
 * Detección de solapamiento entre horarios recurrentes de una misma sala.
 *
 * Dos horarios solapan si TODO esto es verdad:
 *   1. Misma sala (mismo recurso_id).
 *   2. Comparten al menos un día de la semana (dias_semana[] se intersectan).
 *   3. Sus rangos [hora_inicio, hora_inicio + duracion_minutos) se pisan.
 *      Rango medio-abierto: fin == inicio NO es solape (horarios adyacentes ok).
 *
 * Lógica pura — sin React, sin Supabase. Testeable.
 */

export interface HorarioSolapable {
  id: string;
  recurso_id: string;
  dias_semana: number[];
  hora_inicio: string; // 'HH:MM' o 'HH:MM:SS'
  duracion_minutos: number;
  activo: boolean;
}

/** 'HH:MM[:SS]' → minutos desde medianoche. */
function horaAMinutos(hora: string): number {
  const [h, m] = hora.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * ¿Dos horarios recurrentes ocupan la misma sala en el mismo momento?
 * Mismo recurso + días que se cruzan + rangos horarios que se pisan.
 * Intervalos medio-abiertos: se pisan sii `aIni < bFin && bIni < aFin`
 * (por eso fin == inicio da false — son adyacentes, no solapados).
 */
export function horariosSolapan(a: HorarioSolapable, b: HorarioSolapable): boolean {
  if (a.recurso_id !== b.recurso_id) return false;

  const diasCruzan = a.dias_semana.some((d) => b.dias_semana.includes(d));
  if (!diasCruzan) return false;

  const aIni = horaAMinutos(a.hora_inicio);
  const aFin = aIni + a.duracion_minutos;
  const bIni = horaAMinutos(b.hora_inicio);
  const bFin = bIni + b.duracion_minutos;

  return aIni < bFin && bIni < aFin;
}

/**
 * Busca el primer horario ACTIVO existente que solape con `candidato`.
 * Excluye al propio candidato por id — así, al editar, no choca consigo mismo.
 * Los horarios inactivos no cuentan (no generan clases). Devuelve el horario
 * en conflicto (con su tipo concreto) o null si no hay solape.
 */
export function buscarSolape<T extends HorarioSolapable>(
  candidato: HorarioSolapable,
  existentes: T[]
): T | null {
  for (const h of existentes) {
    if (h.id === candidato.id) continue; // no chocar consigo mismo
    if (!h.activo) continue; // los inactivos no bloquean
    if (horariosSolapan(candidato, h)) return h;
  }
  return null;
}
