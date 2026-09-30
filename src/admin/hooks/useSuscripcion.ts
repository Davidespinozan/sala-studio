import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import type { Database } from '@shared/types/database';
import { limiteMiembros, type TierSaas } from '@shared/lib/planesSaas';

export type SuscripcionSaas = Database['public']['Tables']['suscripciones_saas']['Row'];

/** Umbral a partir del cual se avisa que el tenant está cerca del límite. */
const UMBRAL_AVISO = 0.8;

export interface UsoMiembros {
  /** Miembros con algo VIGENTE (plan o paquete): son los que cuentan al límite. */
  miembrosActuales: number;
  /** Todos los que alguna vez se registraron (day passes que no volvieron, bajas, etc.). */
  miembrosRegistrados: number;
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
 *
 * Al límite cuentan solo los miembros con membresía VIGENTE según la autoridad
 * canónica de W5 (v_socio_membresia.vigente = activa AND fin vigente): un day
 * pass expirado, un stale-active o un past_due NO ocupan lugar del plan.
 * `limite` es null si no hay suscripción o si el tier es business (ilimitado).
 */
export function useSuscripcion() {
  const tenant = useTenant();
  const [suscripcion, setSuscripcion] = useState<SuscripcionSaas | null>(null);
  const [uso, setUso] = useState<UsoMiembros | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    setIsLoading(true);

    const [subRes, activosRes, registradosRes] = await Promise.all([
      supabase
        .from('suscripciones_saas')
        .select('*')
        .eq('tenant_id', tenant.id)
        .maybeSingle(),
      // W5 / D-W5-2: "socio activo" = membresía VIGENTE según la autoridad
      // canónica (v_socio_membresia.vigente), NO el proxy usuarios.status +
      // membresia_activa_id. El cap comercial cuenta la misma realidad.
      supabase
        .from('v_socio_membresia')
        .select('usuario_id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('vigente', true),
      supabase
        .from('usuarios')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('rol', 'miembro')
    ]);

    if (subRes.error) console.error('[useSuscripcion]', subRes.error);

    const sub = (subRes.data as SuscripcionSaas | null) ?? null;
    const miembrosActuales = activosRes.count ?? 0;
    const miembrosRegistrados = registradosRes.count ?? 0;
    const limite = sub ? limiteMiembros(sub.tier as TierSaas) : null;
    const porcentajeUsado =
      limite != null && limite > 0 ? Math.round((miembrosActuales / limite) * 100) : null;

    setSuscripcion(sub);
    setUso({
      miembrosActuales,
      miembrosRegistrados,
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
