import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import type { Database } from '@shared/types/database';
import { traducirErrorRPC } from '@member/logic/reservaLogic';

type Reserva = Database['public']['Tables']['reservas']['Row'];
type Recurso = Database['public']['Tables']['recursos']['Row'];

export interface ReservaConRecurso extends Reserva {
  recurso: Pick<Recurso, 'id' | 'slug' | 'nombre'> | null;
}

/**
 * Lista las reservas del usuario actual, con datos del recurso joineado.
 */
export function useReservasDelUsuario() {
  const { usuario } = useAuth();
  const [reservas, setReservas] = useState<ReservaConRecurso[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!usuario) {
      setReservas([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    const { data, error: queryError } = await supabase
      .from('reservas')
      .select('*, recurso:recursos(id, slug, nombre)')
      .eq('usuario_id', usuario.id)
      .order('slot_inicio', { ascending: false });

    if (queryError) {
      setError(queryError.message);
      setIsLoading(false);
      return;
    }

    setReservas((data ?? []) as unknown as ReservaConRecurso[]);
    setIsLoading(false);
  }, [usuario]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { reservas, isLoading, error, refetch };
}

/**
 * Crea una reserva. Modelo virtual: si la clase ya está materializada se reserva
 * por `claseId` (reservar_clase_atomic); si es virtual se pasa `horarioId`+`fecha`
 * y el RPC reservar_clase_virtual la materializa y reserva en un paso. Ambos
 * validan cupo/tier/anticipación/etc. igual.
 */
/**
 * El socio topó su cupo del día por un no-show y el Modelo A (multa por re-reservar)
 * está activo: hay que confirmar la multa antes de reservar. Se sube tipada con el
 * monto para que la pantalla muestre el modal y reintente por el wrapper _con_multa.
 */
export class MultaRequeridaError extends Error {
  readonly centavos: number;
  constructor(centavos: number) {
    super('MULTA_REQUERIDA');
    this.name = 'MultaRequeridaError';
    this.centavos = centavos;
  }
}

export async function crearReserva(params: {
  claseId?: string | null;
  horarioId?: string | null;
  fecha?: string;
  invitados?: number;
  notas?: string;
  /** Lugar elegido en el Mapa de Salón (si la sala tiene layout). */
  lugarId?: string | null;
  /** El socio aceptó la multa (Modelo A): reintenta por el wrapper _con_multa. */
  aceptaMulta?: boolean;
}) {
  // reservar_clase_virtual / los wrappers _con_multa no están en los tipos generados → cast.
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message: string } | null }>;

  const fn = params.claseId
    ? params.aceptaMulta ? 'reservar_clase_atomic_con_multa' : 'reservar_clase_atomic'
    : params.aceptaMulta ? 'reservar_clase_virtual_con_multa' : 'reservar_clase_virtual';

  const args = params.claseId
    ? {
        p_clase_id: params.claseId,
        p_invitados: params.invitados ?? 0,
        p_notas: params.notas,
        p_lugar_id: params.lugarId ?? null
      }
    : {
        p_horario_id: params.horarioId,
        p_fecha: params.fecha,
        p_invitados: params.invitados ?? 0,
        p_notas: params.notas,
        p_lugar_id: params.lugarId ?? null
      };

  const { data, error } = await rpc(fn, args);

  if (error) {
    if (error.message.includes('MULTA_REQUERIDA')) {
      const centavos = parseInt(error.message.match(/MULTA_REQUERIDA:\s*(\d+)/)?.[1] ?? '0', 10);
      throw new MultaRequeridaError(centavos);
    }
    throw new Error(traducirErrorRPC(error.message));
  }
  return data;
}

/**
 * Resultado de cancelar una reserva: status final + si se devolvió crédito.
 * El campo `devolucion_motivo` puede ser:
 *   - 'a_tiempo'    → la cancelación entró dentro de la ventana, se devolvió 1.
 *   - 'tarde'       → fuera de la ventana, no se devolvió.
 *   - 'sin_credito' → tier=tiempo o reserva sin débito previo (nada que devolver).
 *   - 'no_aplica'   → quien canceló no es socio o no tiene membresía vigente.
 */
export interface CancelarReservaResult {
  success: boolean;
  reserva_id: string;
  status: string;
  devuelto: boolean;
  devolucion_motivo: 'a_tiempo' | 'tarde' | 'sin_credito' | 'no_aplica';
  ventana_horas: number;
  creditos_restantes: number | null;
}

/**
 * Cancela una reserva llamando al RPC atómico. Devuelve metadata sobre la
 * ventana de cancelación y la devolución de crédito (si aplica).
 */
export async function cancelarReserva(params: {
  reserva_id: string;
  motivo?: string;
}): Promise<{ data: CancelarReservaResult | null; error: string | null }> {
  const { data, error } = await supabase.rpc('cancelar_reserva_atomic', {
    p_reserva_id: params.reserva_id,
    p_motivo: params.motivo
  });

  if (error) {
    return { data: null, error: traducirErrorRPC(error.message) };
  }
  return { data: data as unknown as CancelarReservaResult, error: null };
}

/**
 * Hook para los recursos del tenant actual.
 */
export function useRecursosDelTenant() {
  const tenant = useTenant();
  const [recursos, setRecursos] = useState<Recurso[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function load() {
      const { data, error } = await supabase
        .from('recursos')
        .select('*')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('orden', { ascending: true });

      if (!isMounted) return;
      if (error) {
        console.error('[useRecursosDelTenant]', error);
        setIsLoading(false);
        return;
      }
      setRecursos(data ?? []);
      setIsLoading(false);
    }

    load();
    return () => { isMounted = false; };
  }, [tenant.id]);

  return { recursos, isLoading };
}

/**
 * Lista las reservas activas (confirmadas o completadas) de un recurso
 * en un rango de fechas. Usado para calcular slots disponibles.
 */
export async function fetchReservasDelRecurso(
  recurso_id: string,
  fechaInicio: Date,
  fechaFin: Date
): Promise<Pick<Reserva, 'slot_inicio'>[]> {
  const { data, error } = await supabase
    .from('reservas')
    .select('slot_inicio')
    .eq('recurso_id', recurso_id)
    .in('status', ['confirmada', 'completada'])
    .gte('slot_inicio', fechaInicio.toISOString())
    .lt('slot_inicio', fechaFin.toISOString());

  if (error) {
    console.error('[fetchReservasDelRecurso]', error);
    return [];
  }
  return data ?? [];
}

/**
 * Lista las reservas activas del usuario en un rango. Para validar regla de continuas.
 */
export async function fetchReservasDelUsuario(
  usuario_id: string,
  fechaInicio: Date,
  fechaFin: Date
): Promise<Pick<Reserva, 'slot_inicio'>[]> {
  const { data, error } = await supabase
    .from('reservas')
    .select('slot_inicio')
    .eq('usuario_id', usuario_id)
    .in('status', ['confirmada', 'completada'])
    .gte('slot_inicio', fechaInicio.toISOString())
    .lt('slot_inicio', fechaFin.toISOString());

  if (error) {
    console.error('[fetchReservasDelUsuario]', error);
    return [];
  }
  return data ?? [];
}
