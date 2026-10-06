import { supabase } from '@shared/lib/supabase';

/** Datos que se capturan de cada invitado al reservar. */
export interface InvitadoDetalle {
  nombre: string;
  telefono: string;
  email: string;
  /** Salas con Mapa de Salón: el asiento del invitado. null si la sala no usa mapa. */
  lugar_id?: string | null;
}

export function invitadoVacio(): InvitadoDetalle {
  return { nombre: '', telefono: '', email: '', lugar_id: null };
}

/** Ajusta la lista para que tenga exactamente `n` invitados (conserva lo escrito). */
export function ajustarInvitados(actual: InvitadoDetalle[], n: number): InvitadoDetalle[] {
  const next = actual.slice(0, n);
  while (next.length < n) next.push(invitadoVacio());
  return next;
}

/**
 * Guarda la identidad de los invitados de una reserva (nombre/teléfono/email).
 * Se llama DESPUÉS de crear la reserva, así que NO toca la ruta de reservar.
 * Best-effort desde la vista del socio: si algo falla, la reserva ya existe y
 * recepción puede completar los datos.
 *
 * `invitados_count` sigue siendo el conteo real (cupo/bolsa); esto solo agrega
 * las identidades. Un invitado sin nombre se ignora (el pase ya se contó igual).
 *
 * Ya no escribe directo en `reserva_invitados` (escritura directa retirada por
 * RLS): cada identidad pasa por la RPC `adjuntar_invitado`, que solo adjunta a
 * un invitado YA contado en la reserva (nunca sube el conteo ni cobra). Se
 * intentan todos; si alguno falla se lanza un error al final (el caller avisa).
 * `tenantId` se conserva en la firma por compatibilidad: el servidor deriva el
 * tenant de la reserva.
 */
export async function guardarInvitados(args: {
  reservaId: string;
  tenantId: string;
  invitados: InvitadoDetalle[];
}): Promise<void> {
  const invitados = args.invitados
    .map((inv) => ({ ...inv, nombre: inv.nombre.trim() }))
    .filter((inv) => inv.nombre);

  if (invitados.length === 0) return;
  // adjuntar_invitado aún no está en los tipos generados → cast acotado.
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ error: { message: string } | null }>;

  const errores: string[] = [];
  for (const inv of invitados) {
    const { error } = await rpc('adjuntar_invitado', {
      p_reserva_id: args.reservaId,
      p_nombre: inv.nombre,
      p_telefono: inv.telefono.trim() || null,
      p_email: inv.email.trim() || null,
      p_lugar_id: inv.lugar_id ?? null
    });
    if (error) errores.push(error.message);
  }
  if (errores.length > 0) throw new Error(errores.join(' | '));
}
