import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { traducirErrorRPC } from '@member/logic/reservaLogic';
import { translateActionError } from '@reception/lib/traducirErrorAccion';

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
// ----------------------------------------------------------------------------
// Todas pasan por RPC. Antes hacían UPDATE directo a `reservas` y por eso la
// MISMA acción daba resultados distintos según la pantalla: cancelar desde acá
// quemaba el crédito del socio, y cancelar desde su ficha se lo devolvía. Igual
// el no-show, que no entraba al ledger y dejaba los reportes mintiendo.
// ============================================================================

/** Corrección de la lista después del hecho (el socio fue y nadie lo checó). */
export async function marcarAsistenciaAdmin(reservaId: string) {
  return supabase.rpc('admin_marcar_asistencia' as never, {
    p_reserva_id: reservaId,
    p_motivo: 'Marcado presente desde la agenda.'
  } as never);
}

/** Registra la falta en el ledger y aplica el bloqueo que el gym haya elegido. */
export async function marcarNoShowAdmin(reservaId: string) {
  return supabase.rpc('recepcion_marcar_no_show' as never, {
    p_reserva_id: reservaId,
    p_motivo: 'Marcado como inasistencia desde la agenda.'
  } as never);
}

/** Cancela y DEVUELVE el crédito (1 + invitados): la cancela el gym, no el socio. */
export async function cancelarReservaAdminQuick(reservaId: string) {
  return supabase.rpc('cancelar_reserva_admin' as never, {
    p_reserva_id: reservaId,
    p_motivo: 'Cancelada por admin desde la agenda.',
    p_notificar: true
  } as never);
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

/**
 * Inscribe a un socio en una clase desde la agenda del admin.
 *
 * Pasa por `recepcion_crear_reserva`, la misma RPC del walk-in de mostrador.
 * Antes hacía un INSERT directo a `reservas`, que no valida NADA: no miraba el
 * cupo (una sala de 12 podía terminar con 15 inscritos), no debitaba el crédito
 * (clase gratis: el gym perdía el ingreso del paquete) y dejaba entrar a socios
 * con la membresía vencida. Todas esas reglas viven en la RPC, no en la tabla.
 */
export async function inscribirMiembroManual(params: {
  claseId: string;
  usuarioId: string;
  /** Walk-in: hacer check-in inmediato tras inscribir (clase de hoy en curso). */
  checkInInmediato?: boolean;
}): Promise<{ error: string | null; checkInError?: string | null }> {
  const { data, error } = await supabase.rpc('recepcion_crear_reserva' as never, {
    p_usuario_id: params.usuarioId,
    p_clase_id: params.claseId,
    p_invitados: 0,
    p_motivo: 'Inscripción manual desde la agenda del admin.'
  } as never);

  if (error) return { error: translateActionError(error.message) };

  if (params.checkInInmediato) {
    const reservaId = (data as { reserva_id?: string } | null)?.reserva_id;
    if (reservaId) {
      const { error: errCheckin } = await supabase.rpc('check_in_manual_atomic', {
        p_reserva_id: reservaId,
        p_motivo: 'Walk-in desde la agenda del admin'
      });
      // La reserva ya existe: un check-in fallido se reporta aparte, no la tira.
      if (errCheckin) return { error: null, checkInError: translateActionError(errCheckin.message) };
    }
  }

  return { error: null };
}
