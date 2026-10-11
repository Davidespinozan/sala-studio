import { supabase } from '@shared/lib/supabase';

/** Descuento del catálogo del gym (Admin → Cobros). Ej. "Estudiante", 20%, 6 meses. */
export interface Descuento {
  id: string;
  nombre: string;
  porcentaje: number;
  /** Vigencia sugerida al otorgarlo; recepción puede ajustar la fecha. */
  vigencia_meses: number;
  activo: boolean;
}

/** Descuento otorgado a un socio. `vence_el` es el último día (inclusive) en que aplica. */
export interface DescuentoDeSocio {
  descuento_id: string;
  nombre: string;
  porcentaje: number;
  activo: boolean;
  vence_el: string; // 'YYYY-MM-DD'
}

// descuentos / socio_descuentos y sus RPCs aún no están en los tipos generados.
type Fila = Record<string, unknown>;
type Consulta = PromiseLike<{ data: Fila[] | null; error: { message: string } | null }> & {
  eq: (c: string, v: unknown) => Consulta;
  order: (c: string, o: { ascending: boolean }) => Consulta;
};
const tabla = (t: string) =>
  (supabase.from.bind(supabase) as unknown as (t: string) => {
    select: (s: string) => Consulta;
    insert: (v: Fila) => PromiseLike<{ error: { message: string } | null }>;
    update: (v: Fila) => { eq: (c: string, v: unknown) => PromiseLike<{ error: { message: string } | null }> };
  })(t);
const rpc = supabase.rpc.bind(supabase) as unknown as (
  name: string,
  args: Record<string, unknown>
) => Promise<{ data: unknown; error: { message: string } | null }>;

export async function listarDescuentos(
  tenantId: string
): Promise<{ descuentos: Descuento[]; error: string | null }> {
  const { data, error } = await tabla('descuentos')
    .select('id, nombre, porcentaje, vigencia_meses, activo')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });
  return { descuentos: (data ?? []) as unknown as Descuento[], error: error?.message ?? null };
}

export async function crearDescuento(
  tenantId: string,
  d: Pick<Descuento, 'nombre' | 'porcentaje' | 'vigencia_meses'>
): Promise<{ error: string | null }> {
  const { error } = await tabla('descuentos').insert({ tenant_id: tenantId, ...d });
  return { error: error?.message ?? null };
}

export async function actualizarDescuento(
  id: string,
  d: Partial<Pick<Descuento, 'nombre' | 'porcentaje' | 'vigencia_meses' | 'activo'>>
): Promise<{ error: string | null }> {
  const { error } = await tabla('descuentos').update(d).eq('id', id);
  return { error: error?.message ?? null };
}

export async function descuentoDeSocio(
  usuarioId: string
): Promise<{ descuento: DescuentoDeSocio | null; error: string | null }> {
  const { data, error } = await tabla('socio_descuentos')
    .select('descuento_id, vence_el, descuento:descuentos(nombre, porcentaje, activo)')
    .eq('usuario_id', usuarioId);
  const fila = (data ?? [])[0] as
    | { descuento_id: string; vence_el: string; descuento: { nombre: string; porcentaje: number; activo: boolean } | null }
    | undefined;
  if (!fila?.descuento) return { descuento: null, error: error?.message ?? null };
  return {
    descuento: {
      descuento_id: fila.descuento_id,
      vence_el: fila.vence_el,
      nombre: fila.descuento.nombre,
      porcentaje: fila.descuento.porcentaje,
      activo: fila.descuento.activo
    },
    error: null
  };
}

/** Solo recepción/admin (la base lo enforce). `venceEl` vacío → vigencia del descuento. */
export async function otorgarDescuentoSocio(
  usuarioId: string,
  descuentoId: string,
  venceEl: string | null
): Promise<{ error: string | null }> {
  const { error } = await rpc('otorgar_descuento_socio', {
    p_usuario_id: usuarioId,
    p_descuento_id: descuentoId,
    p_vence_el: venceEl
  });
  return { error: error?.message ?? null };
}

export async function quitarDescuentoSocio(usuarioId: string): Promise<{ error: string | null }> {
  const { error } = await rpc('quitar_descuento_socio', { p_usuario_id: usuarioId });
  return { error: error?.message ?? null };
}

/** Fecha sugerida de vencimiento: hoy (en la zona del gym) + N meses, 'YYYY-MM-DD'. */
export function venceSugerido(hoy: string, meses: number): string {
  const [y, m, d] = hoy.split('-').map(Number);
  const f = new Date(Date.UTC(y, m - 1 + meses, d));
  // 31-ago + 6 meses no existe (31-feb): Date lo desborda a marzo → recortar al fin de mes.
  if (f.getUTCDate() !== d) f.setUTCDate(0);
  return f.toISOString().slice(0, 10);
}

/** Texto del error de los RPCs de descuento, sin el código técnico. */
export function traducirErrorDescuento(msg: string): string {
  if (msg.includes('NO_AUTORIZADO')) return 'Solo recepción o admin pueden cambiar el descuento.';
  if (msg.includes('DESCUENTO_INACTIVO')) return 'Ese descuento está desactivado.';
  if (msg.includes('FECHA_INVALIDA')) return 'La fecha de vencimiento no es válida (ya pasó o es mayor a 24 meses).';
  if (msg.includes('SUCURSAL_')) return 'Ese socio pertenece a otra sede.';
  if (msg.includes('descuentos_tenant_nombre_uniq')) return 'Ya tienes un descuento con ese nombre.';
  return 'No pudimos guardar el descuento. Prueba de nuevo.';
}
