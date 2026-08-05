import { supabase } from '@shared/lib/supabase';

/** Datos que se capturan de cada invitado al reservar. */
export interface InvitadoDetalle {
  nombre: string;
  telefono: string;
  email: string;
}

export function invitadoVacio(): InvitadoDetalle {
  return { nombre: '', telefono: '', email: '' };
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
 */
export async function guardarInvitados(args: {
  reservaId: string;
  tenantId: string;
  invitados: InvitadoDetalle[];
}): Promise<void> {
  const rows = args.invitados
    .map((inv) => ({ ...inv, nombre: inv.nombre.trim() }))
    .filter((inv) => inv.nombre)
    .map((inv) => ({
      tenant_id: args.tenantId,
      reserva_id: args.reservaId,
      nombre: inv.nombre,
      telefono: inv.telefono.trim() || null,
      email: inv.email.trim() || null
    }));

  if (rows.length === 0) return;
  // La tabla aún no está en los tipos generados → cast acotado.
  const insertar = (supabase.from as unknown as (t: string) => {
    insert: (r: unknown) => Promise<{ error: { message: string } | null }>;
  })('reserva_invitados').insert(rows);
  const { error } = await insertar;
  if (error) throw new Error(error.message);
}
