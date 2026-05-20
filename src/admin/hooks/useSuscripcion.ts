import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import type { Database } from '@shared/types/database';
import { limiteMiembros, type TierSaas } from '../lib/planesSaas';

export type SuscripcionSaas = Database['public']['Tables']['suscripciones_saas']['Row'];

/** Umbral a partir del cual se avisa que el tenant está cerca del límite. */
const UMBRAL_AVISO = 0.8;

export interface UsoMiembros {
  miembrosActuales: number;
  /** Límite del tier. null = ilimitado (business) o sin suscripción. */
  limite: number | null;
  /** % usado. null cuando no hay límite. */
  porcentajeUsado: number | null;
  /** Está al 80%+ del límite. */
  cerca: boolean;
  /** Pasó el 100% del límite. */
  excedido: boolean;
}

/**
 * Suscripción del tenant al SaaS + uso de miembros vs. el límite del tier.
 * `uso` se calcula siempre (cuenta miembros activos); `limite` es null si no
 * hay suscripción o si el tier es business (ilimitado).
 */
export function useSuscripcion() {
  const tenant = useTenant();
  const [suscripcion, setSuscripcion] = useState<SuscripcionSaas | null>(null);
  const [uso, setUso] = useState<UsoMiembros | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    setIsLoading(true);

    const [subRes, countRes] = await Promise.all([
      supabase
        .from('suscripciones_saas')
        .select('*')
        .eq('tenant_id', tenant.id)
        .maybeSingle(),
      supabase
        .from('usuarios')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('rol', 'miembro')
        .eq('status', 'activo')
    ]);

    if (subRes.error) console.error('[useSuscripcion]', subRes.error);

    const sub = (subRes.data as SuscripcionSaas | null) ?? null;
    const miembrosActuales = countRes.count ?? 0;
    const limite = sub ? limiteMiembros(sub.tier as TierSaas) : null;
    const porcentajeUsado =
      limite != null && limite > 0 ? Math.round((miembrosActuales / limite) * 100) : null;

    setSuscripcion(sub);
    setUso({
      miembrosActuales,
      limite,
      porcentajeUsado,
      cerca: limite != null && limite > 0 && miembrosActuales / limite >= UMBRAL_AVISO,
      excedido: limite != null && miembrosActuales > limite
    });
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { suscripcion, uso, isLoading, refetch };
}
