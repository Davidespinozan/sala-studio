import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

export interface InscritoAdmin {
  reservaId: string;
  usuarioId: string;
  nombre: string;
  email: string;
  planSlug: string | null;
  status: 'confirmada' | 'cancelada' | 'completada' | 'no_show';
  folio: string;
}

export interface MiembroBuscable {
  id: string;
  nombre: string | null;
  email: string;
  membresia_tier: string | null;
}

/** Fetch reservas (todas las status) de un slot específico, join a usuarios. */
export function useInscritosDeClase(
  recursoId: string | null,
  slotInicio: Date | null
) {
  const [inscritos, setInscritos] = useState<InscritoAdmin[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const slotISO = slotInicio?.toISOString() ?? null;

  const refetch = useCallback(async () => {
    if (!recursoId || !slotISO) {
      setInscritos([]);
      return;
    }
    setIsLoading(true);
    const { data, error } = await supabase
      .from('reservas')
      .select(
        'id, status, folio, usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier)'
      )
      .eq('recurso_id', recursoId)
      .eq('slot_inicio', slotISO)
      .order('id', { ascending: true });

    if (error) {
      console.error('[useInscritosDeClase]', error);
      setIsLoading(false);
      return;
    }

    const rows = (data ?? []) as unknown as Array<{
      id: string;
      status: string;
      folio: string;
      usuario: {
        id: string;
        nombre: string | null;
        email: string;
        membresia_tier: string | null;
      } | null;
    }>;

    setInscritos(
      rows.map((r) => ({
        reservaId: r.id,
        usuarioId: r.usuario?.id ?? '',
        nombre: r.usuario?.nombre ?? r.usuario?.email ?? '—',
        email: r.usuario?.email ?? '',
        planSlug: r.usuario?.membresia_tier ?? null,
        status: r.status as InscritoAdmin['status'],
        folio: r.folio
      }))
    );
    setIsLoading(false);
  }, [recursoId, slotISO]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { inscritos, isLoading, refetch };
}

// ============================================================================
// Mutations (admin acciones rápidas)
// ============================================================================

export async function marcarAsistenciaAdmin(reservaId: string, byUsuarioId: string) {
  return supabase
    .from('reservas')
    .update({
      status: 'completada',
      check_in_at: new Date().toISOString(),
      check_in_by: byUsuarioId,
      check_in_method: 'manual'
    } as never)
    .eq('id', reservaId);
}

export async function marcarNoShowAdmin(reservaId: string) {
  return supabase.from('reservas').update({ status: 'no_show' }).eq('id', reservaId);
}

export async function cancelarReservaAdminQuick(reservaId: string) {
  return supabase
    .from('reservas')
    .update({
      status: 'cancelada',
      cancelada_at: new Date().toISOString(),
      cancelada_motivo: 'Cancelada por admin desde agenda.'
    } as never)
    .eq('id', reservaId);
}

// ============================================================================
// Búsqueda de miembros + alta manual
// ============================================================================

/** Search por nombre o email (ilike). Excluye usuarios ya inscritos al slot. */
export async function buscarMiembrosTenant(
  tenantId: string,
  query: string,
  excludeIds: string[] = []
): Promise<MiembroBuscable[]> {
  const term = query.trim();
  if (term.length < 2) return [];
  const like = `%${term}%`;
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nombre, email, membresia_tier')
    .eq('tenant_id', tenantId)
    .eq('rol', 'miembro')
    .eq('status', 'activo')
    .or(`nombre.ilike.${like},email.ilike.${like}`)
    .order('nombre', { ascending: true })
    .limit(20);
  if (error) {
    console.error('[buscarMiembrosTenant]', error);
    return [];
  }
  return (data ?? []).filter((m) => !excludeIds.includes(m.id));
}

export async function inscribirMiembroManual(params: {
  tenantId: string;
  recursoId: string;
  usuarioId: string;
  slotInicio: Date;
  slotFin: Date;
  duracionMin: number;
}) {
  // Folio único basado en timestamp + random para reservas creadas por admin
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0');
  const folio = `SAL-ADM-${stamp}-${rand}`;

  return supabase.from('reservas').insert({
    tenant_id: params.tenantId,
    recurso_id: params.recursoId,
    usuario_id: params.usuarioId,
    slot_inicio: params.slotInicio.toISOString(),
    slot_fin: params.slotFin.toISOString(),
    duracion_min: params.duracionMin,
    folio,
    status: 'confirmada',
    invitados_count: 0
  } as never);
}
