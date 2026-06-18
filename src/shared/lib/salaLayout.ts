/**
 * Mapa de Salón: tipos + presets compartidos (admin builder y vista del socio).
 * Se guarda en `recursos.layout` (jsonb). NULL = sala sin mapa (cupo por conteo).
 */

export type IconoSala = 'bici' | 'mat' | 'reformer' | 'generico';

export interface LugarLayout {
  id: string; // estable; lo referencia reservas.lugar_id
  label: string; // lo que ve el socio ('1', '2', 'A1'…)
  x: number; // columna en el grid
  y: number; // fila en el grid
}

export interface ElementoLayout {
  tipo: 'instructor' | 'puerta' | 'espejo';
  x: number;
  y: number;
  label?: string;
}

export interface SalaLayout {
  tipo_icono: IconoSala;
  cols: number;
  rows: number;
  lugares: LugarLayout[];
  elementos: ElementoLayout[];
}

export const ICONO_LABEL: Record<IconoSala, string> = {
  bici: 'Bicicleta',
  mat: 'Mat',
  reformer: 'Reformer',
  generico: 'Lugar'
};

/** Emoji de muestra por ícono (render liviano, sin assets). */
export const ICONO_EMOJI: Record<IconoSala, string> = {
  bici: '🚲',
  mat: '🧘',
  reformer: '🛏️',
  generico: '◼️'
};

export const GRID_MAX = 14;

function lugaresEnGrid(filas: number, porFila: number, offsetY = 1): LugarLayout[] {
  const out: LugarLayout[] = [];
  let n = 1;
  for (let r = 0; r < filas; r++) {
    for (let c = 0; c < porFila; c++) {
      out.push({ id: `L${n}`, label: String(n), x: c, y: r + offsetY });
      n++;
    }
  }
  return out;
}

export interface Preset {
  id: string;
  nombre: string;
  build: () => SalaLayout;
}

/** Plantillas de arranque por disciplina — el admin elige una y la ajusta. */
export const PRESETS: Preset[] = [
  {
    id: 'cycling-2x6',
    nombre: 'Cycling · 2 filas de 6',
    build: () => ({
      tipo_icono: 'bici',
      cols: 6,
      rows: 3,
      elementos: [{ tipo: 'instructor', x: 2, y: 0, label: 'Coach' }],
      lugares: lugaresEnGrid(2, 6)
    })
  },
  {
    id: 'yoga-4x5',
    nombre: 'Yoga · cuadrícula 5×4',
    build: () => ({
      tipo_icono: 'mat',
      cols: 5,
      rows: 5,
      elementos: [{ tipo: 'instructor', x: 2, y: 0, label: 'Frente' }],
      lugares: lugaresEnGrid(4, 5)
    })
  },
  {
    id: 'reformer-8',
    nombre: 'Reformer · fila de 8',
    build: () => ({
      tipo_icono: 'reformer',
      cols: 8,
      rows: 2,
      elementos: [{ tipo: 'instructor', x: 3, y: 0, label: 'Frente' }],
      lugares: lugaresEnGrid(1, 8)
    })
  },
  {
    id: 'vacio',
    nombre: 'Empezar vacío',
    build: () => ({
      tipo_icono: 'generico',
      cols: 8,
      rows: 6,
      elementos: [],
      lugares: []
    })
  }
];

/** Re-numera los lugares 1..N en orden de lectura (fila, luego columna). */
export function renumerar(lugares: LugarLayout[]): LugarLayout[] {
  const orden = [...lugares].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return orden.map((l, i) => ({ ...l, id: `L${i + 1}`, label: String(i + 1) }));
}
