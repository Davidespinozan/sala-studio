import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';

export type TipoTier = 'tiempo' | 'creditos' | 'hibrido';
export type StatusMembresia =
  | 'pendiente'
  | 'trialing'
  | 'activa'
  | 'past_due'
  | 'cancelada'
  | 'expirada'
  | 'congelada';

/** Membresía activa del socio + tier joineado. Forma plana para consumir desde la UI. */
export interface MembresiaActual {
  id: string;
  status: StatusMembresia;
  periodo_actual_inicio: string | null;
  periodo_actual_fin: string | null;
  creditos_restantes: number | null;
  tier_id: string;
  tier_slug: string;
  tier_nombre: string;
  tier_tipo: TipoTier;
  duracion_dias: number | null;
  clases_incluidas: number | null;
  /** true = pase suelto (day pass): reserva más allá de su vigencia (sigue a su clase). */
  es_pase: boolean;
  /** Sede a la que se suscribió (null = sin sede / acceso global). */
  sucursal_id: string | null;
  /** El plan da acceso a todas las sedes (true) o solo a la suscrita (false). */
  tier_acceso_todas_sucursales: boolean;
  /** NOT NULL = el socio pidió cancelar: sigue con acceso hasta que termine el
   *  periodo pagado, y puede reactivar hasta entonces. */
  cancelada_at: string | null;
  /** Cuándo deja de tener acceso si no reactiva. */
  cancelada_efectiva_at: string | null;
  /** Vigencia CANÓNICA (W5-A es_membresia_vigente), calculada en el servidor
   *  (v_socio_membresia). NO se rederiva en el front. */
  vigente: boolean;
}

/**
 * Estado derivado de la membresía para decidir qué mostrar al socio.
 * Refleja exactamente las cuatro condiciones de bloqueo del gate (Fase 2A.2)
 * más el caso "sana" en que el socio puede reservar normal.
 */
export type EstadoMembresia =
  | 'sin_membresia'
  | 'congelada'
  | 'past_due'
  | 'vencida'
  | 'sin_creditos'
  | 'sana';

/**
 * Calcula el estado de display de una membresía. Pura. La VIGENCIA es canónica
 * (W5): viene de `m.vigente` (servidor, es_membresia_vigente); NO se rederiva
 * acá con fechas. El estado solo mapea vigente + status + tipo + créditos al
 * mensaje que ve el socio.
 */
export function membresiaEstado(m: MembresiaActual | null): EstadoMembresia {
  if (!m) return 'sin_membresia';
  if (m.status === 'congelada') return 'congelada';
  if (m.status === 'past_due') return 'past_due'; // pago de renovación falló (dunning)
  if (!m.vigente) return 'vencida'; // vigencia canónica del servidor (W5)
  if (
    (m.tier_tipo === 'creditos' || m.tier_tipo === 'hibrido') &&
    (m.creditos_restantes ?? 0) <= 0
  ) {
    return 'sin_creditos';
  }
  return 'sana';
}

/**
 * Trae la membresía "activa" del socio (cualquiera de los estados vigentes
 * — incluye 'congelada' para distinguir entre pausada vs sin membresía).
 * Devuelve null si no hay fila (caso: socio sin membresía nunca creada).
 *
 * Autoridad canónica (W5): lee v_socio_membresia (selector membresia_actual_id
 * + predicado es_membresia_vigente). Una sola fuente; no rederiva vigencia.
 *
 * @param usuarioId — si se pasa, lee la membresía de ese usuario (modo admin
 *   viendo a otro socio). Si se omite, lee la del usuario actual (modo socio).
 *
 * RLS: socio lee solo su propia fila vía membresias_read_self. Admin/recepción
 * leen cualquier fila de su tenant vía membresias_read_admin. Tiers se leen
 * vía tiers_read_tenant. No requiere policy nueva.
 */
export function useMembresiaActual(usuarioId?: string) {
  const { usuario } = useAuth();
  const targetId = usuarioId ?? usuario?.id;
  const [membresia, setMembresia] = useState<MembresiaActual | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!targetId) {
      setMembresia(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);

    // Autoridad canónica (W5): la membresía ACTUAL y su VIGENCIA salen de
    // v_socio_membresia (membresia_actual_id + es_membresia_vigente). No se
    // rederiva vigencia acá ni se usa el cache usuarios.* como autoridad.
    const { data, error: qerr } = await supabase
      .from('v_socio_membresia')
      .select(
        'membresia_id, membresia_status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes, tier_id, tier_slug, tier_nombre, tier_tipo, duracion_dias, clases_incluidas, es_pase, tier_acceso_todas_sucursales, sucursal_id, cancelada_at, cancelada_efectiva_at, vigente'
      )
      .eq('usuario_id', targetId)
      .maybeSingle();

    if (qerr) {
      setError(qerr.message);
      setMembresia(null);
      setIsLoading(false);
      return;
    }

    if (!data || !data.membresia_id) {
      setMembresia(null);
      setIsLoading(false);
      return;
    }

    setMembresia({
      id: data.membresia_id,
      status: data.membresia_status as StatusMembresia,
      cancelada_at: data.cancelada_at ?? null,
      cancelada_efectiva_at: data.cancelada_efectiva_at ?? null,
      periodo_actual_inicio: data.periodo_actual_inicio,
      periodo_actual_fin: data.periodo_actual_fin,
      creditos_restantes: data.creditos_restantes,
      tier_id: data.tier_id as string,
      tier_slug: data.tier_slug as string,
      tier_nombre: data.tier_nombre as string,
      tier_tipo: data.tier_tipo as TipoTier,
      duracion_dias: data.duracion_dias,
      clases_incluidas: data.clases_incluidas,
      sucursal_id: data.sucursal_id,
      tier_acceso_todas_sucursales: data.tier_acceso_todas_sucursales ?? true,
      es_pase: data.es_pase ?? false,
      vigente: data.vigente ?? false
    });
    setIsLoading(false);
  }, [targetId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { membresia, isLoading, error, refetch };
}
