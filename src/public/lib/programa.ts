/**
 * Lógica del programa de la semana. Vivía dentro del componente, así que no se
 * podía testear sin renderizar media landing.
 */

export interface HorarioBase {
  nombre: string;
  descripcion: string | null;
  dias_semana: number[];
  hora_inicio: string;
  cupo_max?: number | null;
}

export interface ClaseDelDia {
  nombre: string;
  enfoque: string | null;
  cupo: number | null;
  horas: string[];
}

/** "05:00" → "5:00", "16:00" → "4:00". Sin AM/PM: la franja lo dice. */
export function formatearHora(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mStr}`;
}

/** Antes del mediodía o después: define en qué bloque va el chip. */
export function esManana(hhmm: string): boolean {
  return Number(hhmm.slice(0, 2)) < 12;
}

/**
 * Agrupa las franjas de un día POR CLASE.
 *
 * La misma clase se repite en muchas franjas (5am…8pm): listarlas una por una
 * repetía el nombre y el enfoque diez veces por día y la sección era una pared.
 * Agrupa por nombre+enfoque, así un gym con dos entrenamientos distintos el
 * mismo día sigue viéndolos separados.
 */
export function agruparPorClase<T extends HorarioBase>(
  horarios: T[],
  dow: number
): ClaseDelDia[] {
  const delDia = horarios.filter((h) => h.dias_semana.includes(dow));
  const porClase = new Map<string, ClaseDelDia>();

  for (const h of delDia) {
    const clave = `${h.nombre}|${h.descripcion ?? ''}`;
    const entrada = porClase.get(clave) ?? {
      nombre: h.nombre,
      enfoque: h.descripcion,
      cupo: h.cupo_max ?? null,
      horas: []
    };
    entrada.horas.push(h.hora_inicio.slice(0, 5));
    porClase.set(clave, entrada);
  }

  // Las horas se ordenan en 24h (así la tarde va después de la mañana) aunque
  // después se muestren en 12h.
  for (const c of porClase.values()) c.horas.sort();

  return [...porClase.values()];
}
