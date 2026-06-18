import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { traducirErrorRPC } from '@member/logic/reservaLogic';

export interface InscritoAdmin {
  reservaId: string;
  usuarioId: string;
  nombre: string;
  email: string;
  planSlug: string | null;
  status: 'confirmada' | 'cancelada' | 'completada' | 'no_show';
  folio: string;
  lugarId: string | null;
}

export interface MiembroBuscable {
  id: string;
  nombre: string | null;
  email: string;
  membresia_tier: string | null;
}

/** Fetch reservas (todas las status) de una clase concreta, join a usuarios.
 *  S4.2: ahora filtra por clase_id (antes era recurso_id + slot_inicio). */
export function useInscritosDeClase(claseId: string | null) {
  const [inscritos, setInscritos] = useState<InscritoAdmin[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!claseId) {
      setInscritos([]);
      return;
    }
    setIsLoading(true);
    const { data, error } = await supabase
      .from('reservas')
      .select(
        'id, status, folio, lugar_id, usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier)'
      )
      .eq('clase_id', claseId)
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
      lugar_id: string | null;
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
        folio: r.folio,
        lugarId: r.lugar_id ?? null
      }))
    );
    setIsLoading(false);
  }, [claseId]);

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

// ============================================================================
// Lista de espera (admin)
// ============================================================================

export interface EnEsperaAdmin {
  listaEsperaId: string;
  usuarioId: string;
  nombre: string;
  email: string;
  planSlug: string | null;
  posicion: number;
  createdAt: string;
}

/** Fetch de la lista de espera (status 'esperando') de una clase, en orden FIFO. */
export function useListaEsperaDeClase(claseId: string | null) {
  const [enEspera, setEnEspera] = useState<EnEsperaAdmin[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!claseId) {
      setEnEspera([]);
      return;
    }
    setIsLoading(true);
    const { data, error } = await supabase
      .from('lista_espera')
      .select('id, created_at, usuario:usuarios(id, nombre, email, membresia_tier)')
      .eq('clase_id', claseId)
      .eq('status', 'esperando')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[useListaEsperaDeClase]', error);
      setIsLoading(false);
      return;
    }

    const rows = (data ?? []) as unknown as Array<{
      id: string;
      created_at: string;
      usuario: {
        id: string;
        nombre: string | null;
        email: string;
        membresia_tier: string | null;
      } | null;
    }>;

    setEnEspera(
      rows.map((r, i) => ({
        listaEsperaId: r.id,
        usuarioId: r.usuario?.id ?? '',
        nombre: r.usuario?.nombre ?? r.usuario?.email ?? '—',
        email: r.usuario?.email ?? '',
        planSlug: r.usuario?.membresia_tier ?? null,
        posicion: i + 1,
        createdAt: r.created_at
      }))
    );
    setIsLoading(false);
  }, [claseId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { enEspera, isLoading, refetch };
}

/** Promueve manualmente a una persona de la lista de espera (saltea el FIFO). */
export async function promoverManualEspera(
  listaEsperaId: string
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('promover_manual_lista_espera', {
    p_lista_espera_id: listaEsperaId
  });
  return { error: error ? traducirErrorRPC(error.message) : null };
}

export async function inscribirMiembroManual(params: {
  tenantId: string;
  claseId: string;
  recursoId: string;
  usuarioId: string;
  slotInicio: Date;
  slotFin: Date;
  duracionMin: number;
}) {
  // Folio único basado en timestamp + random para reservas creadas por admin.
  // S4.2: incluye clase_id para mantener integridad con la nueva tabla.
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
    invitados_count: 0,
    clase_id: params.claseId
  } as never);
}
