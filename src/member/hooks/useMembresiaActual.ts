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
}

/**
 * Estado derivado de la membresía para decidir qué mostrar al socio.
 * Refleja exactamente las cuatro condiciones de bloqueo del gate (Fase 2A.2)
 * más el caso "sana" en que el socio puede reservar normal.
 */
export type EstadoMembresia =
  | 'sin_membresia'
  | 'congelada'
  | 'vencida'
  | 'sin_creditos'
  | 'sana';

/**
 * Calcula el estado de una membresía. Pura — usa now() solo si recibe la
 * fecha de comparación como parámetro (default: Date.now()). Testeable.
 */
export function membresiaEstado(
  m: MembresiaActual | null,
  now: Date = new Date()
): EstadoMembresia {
  if (!m) return 'sin_membresia';
  if (m.status === 'congelada') return 'congelada';
  if (m.periodo_actual_fin && new Date(m.periodo_actual_fin) <= now) return 'vencida';
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
 * Misma fuente de verdad que el gate (Fase 2A.2): SELECT por usuario_id en
 * status IN ('trialing','activa','past_due','congelada'), pick más reciente.
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

    const { data, error: qerr } = await supabase
      .from('membresias')
      .select(
        'id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes, tier_id, tier:tiers(slug, nombre, tipo, duracion_dias, clases_incluidas)'
      )
      .eq('usuario_id', targetId)
      .in('status', ['trialing', 'activa', 'past_due', 'congelada'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (qerr) {
      setError(qerr.message);
      setMembresia(null);
      setIsLoading(false);
      return;
    }

    if (!data || !data.tier) {
      setMembresia(null);
      setIsLoading(false);
      return;
    }

    const tier = data.tier as unknown as {
      slug: string;
      nombre: string;
      tipo: string;
      duracion_dias: number | null;
      clases_incluidas: number | null;
    };

    setMembresia({
      id: data.id,
      status: data.status as StatusMembresia,
      periodo_actual_inicio: data.periodo_actual_inicio,
      periodo_actual_fin: data.periodo_actual_fin,
      creditos_restantes: data.creditos_restantes,
      tier_id: data.tier_id,
      tier_slug: tier.slug,
      tier_nombre: tier.nombre,
      tier_tipo: tier.tipo as TipoTier,
      duracion_dias: tier.duracion_dias,
      clases_incluidas: tier.clases_incluidas
    });
    setIsLoading(false);
  }, [targetId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { membresia, isLoading, error, refetch };
}
