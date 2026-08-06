import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useVisibilityAwarePolling } from '@shared/hooks/useVisibilityAwarePolling';
import { getTenantTimezone, hoyEnTimezone, sumarDias, instanteDeClase } from '@shared/lib/timezone';
import { useReceptionSucursal } from '../providers/ReceptionSucursalProvider';
import type { Database } from '@shared/types/database';

type Reserva = Database['public']['Tables']['reservas']['Row'];
type Usuario = Database['public']['Tables']['usuarios']['Row'];
type Recurso = Database['public']['Tables']['recursos']['Row'];

export interface ReservaConJoin extends Reserva {
  recurso: Pick<Recurso, 'id' | 'slug' | 'nombre'> | null;
  usuario: Pick<Usuario, 'id' | 'nombre' | 'email' | 'membresia_tier' | 'avatar_url'> | null;
}

/**
 * Reservas de un día específico (default hoy) del tenant, ordenadas por hora.
 * `fechaISO` es 'YYYY-MM-DD' en la zona del GYM (no del navegador): así la
 * ventana del día es la del gym aunque el dueño mire desde otra zona horaria.
 * Polling cada 30s.
 */
export function useReservasHoy(fechaISO?: string) {
  const tenant = useTenant();
  const tz = getTenantTimezone(tenant);
  const { sucursalId } = useReceptionSucursal();
  const [reservas, setReservas] = useState<ReservaConJoin[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const dia = fechaISO ?? hoyEnTimezone(tz);

  const refetch = useCallback(async () => {
    // Ventana [00:00 del día, 00:00 del día siguiente) en la zona del gym → UTC.
    const inicio = instanteDeClase(dia, '00:00', tz);
    const fin = instanteDeClase(sumarDias(dia, 1), '00:00', tz);

    // !inner + filtro por recurso.sucursal_id scopea la recepción a su sede
    // (las reservas no tienen sucursal_id directo; va por la sala). Mismo patrón
    // que useReservasRango del admin.
    let query = supabase
      .from('reservas')
      .select('*, recurso:recursos!inner(id, slug, nombre, sucursal_id), usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier, avatar_url)')
      .eq('tenant_id', tenant.id)
      .gte('slot_inicio', inicio.toISOString())
      .lt('slot_inicio', fin.toISOString())
      .order('slot_inicio', { ascending: true });

    if (sucursalId) query = query.eq('recurso.sucursal_id', sucursalId);

    const { data, error } = await query;

    if (error) {
      console.error('[useReservasHoy]', error);
      setIsLoading(false);
      return;
    }
    setReservas((data ?? []) as unknown as ReservaConJoin[]);
    setIsLoading(false);
  }, [tenant.id, dia, tz, sucursalId]);

  // Carga inicial + recarga al cambiar de día (cambia la identidad de refetch).
  useEffect(() => {
    refetch();
  }, [refetch]);

  // Polling cada 30s que se pausa con la pestaña en background y refetchea al volver.
  useVisibilityAwarePolling(refetch, 30_000);

  return { reservas, isLoading, refetch };
}

/**
 * Reservas de los próximos N días (default 7) del tenant, para la Agenda de
 * recepción (solo-lectura). Mismo scope de sede que useReservasHoy. Sin polling.
 */
export function useReservasSemana(dias = 7) {
  const tenant = useTenant();
  const tz = getTenantTimezone(tenant);
  const { sucursalId } = useReceptionSucursal();
  const [reservas, setReservas] = useState<ReservaConJoin[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    // Desde 00:00 de hoy en la zona del gym, N días hacia adelante.
    const hoy = hoyEnTimezone(tz);
    const inicio = instanteDeClase(hoy, '00:00', tz);
    const fin = instanteDeClase(sumarDias(hoy, dias), '00:00', tz);

    let query = supabase
      .from('reservas')
      .select('*, recurso:recursos!inner(id, slug, nombre, sucursal_id), usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier, avatar_url)')
      .eq('tenant_id', tenant.id)
      .gte('slot_inicio', inicio.toISOString())
      .lt('slot_inicio', fin.toISOString())
      .order('slot_inicio', { ascending: true });

    if (sucursalId) query = query.eq('recurso.sucursal_id', sucursalId);

    const { data, error } = await query;
    if (error) {
      console.error('[useReservasSemana]', error);
      setIsLoading(false);
      return;
    }
    setReservas((data ?? []) as unknown as ReservaConJoin[]);
    setIsLoading(false);
  }, [tenant.id, sucursalId, dias, tz]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { reservas, isLoading, refetch };
}

export async function checkInManual(reservaId: string, motivo?: string) {
  const { data, error } = await supabase.rpc('check_in_manual_atomic', {
    p_reserva_id: reservaId,
    p_motivo: motivo ?? undefined
  });

  if (error) {
    // Código = token MAYÚSCULAS_CON_GUION ("DEMASIADO_TARDE: ..."). El regex
    // viejo (/_[A-Z_]+/) lo extraía mal y el mapa de abajo nunca pegaba.
    const code = error.message.match(/[A-Z][A-Z0-9]*_[A-Z0-9_]+/)?.[0] ?? 'ERROR';
    throw new Error(translateError(code, error.message));
  }
  return data;
}

/** Cobra la multa (Modelo A) de una reserva y la registra en la Caja. */
export async function cobrarMultaReserva(
  reservaId: string,
  metodo: 'efectivo' | 'tarjeta' | 'transferencia'
) {
  // cobrar_multa_reserva no está en los tipos generados todavía → cast.
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc('cobrar_multa_reserva', {
    p_reserva_id: reservaId,
    p_metodo: metodo
  });
  if (error) {
    const code = error.message.match(/[A-Z][A-Z0-9]*_[A-Z0-9_]+/)?.[0] ?? 'ERROR';
    throw new Error(translateError(code, error.message));
  }
  return data;
}

function translateError(code: string, fallback: string): string {
  const map: Record<string, string> = {
    RESERVA_NO_EXISTE: 'No encontramos esa reserva',
    YA_CHECK_IN: 'Este miembro ya hizo check-in',
    RESERVA_CANCELADA: 'Esta reserva está cancelada',
    RESERVA_NO_SHOW: 'Esta reserva quedó marcada como inasistencia',
    DEMASIADO_TEMPRANO: 'Todavía es muy temprano para el check-in',
    DEMASIADO_TARDE: 'El check-in ya cerró',
    SUCURSAL_DIFERENTE: 'Esta reserva es de otra sede',
    NO_AUTORIZADO: 'No tienes permiso para hacer esta acción',
    SIN_MULTA: 'Esta reserva no tiene multa que cobrar',
    MULTA_YA_PAGADA: 'Esta multa ya se cobró',
    METODO_INVALIDO: 'Método de pago no válido'
  };
  return map[code] ?? fallback.replace(code + ':', '').trim();
}
