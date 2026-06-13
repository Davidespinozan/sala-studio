import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';

/**
 * Estado de activación de un gym nuevo: qué pasos mínimos ya completó el dueño.
 *
 * Los 3 ESENCIALES (sala, horarios, plan con precio) son los que hacen que el
 * estudio pueda recibir reservas — un gym recién creado nace con sala sembrada
 * pero SIN horarios y con planes en $0, así que sin guía queda "muerto".
 * Los 2 recomendados (instructor, marca) elevan la experiencia pero no bloquean.
 */
export interface GymSetup {
  sala: boolean;
  horarios: boolean;
  plan: boolean;
  instructor: boolean;
  marca: boolean;
}

export function useGymSetup() {
  const tenant = useTenant();
  const [setup, setSetup] = useState<GymSetup | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const tid = tenant.id;
      const [sala, horarios, plan, instructor] = await Promise.all([
        supabase.from('recursos').select('id', { count: 'exact', head: true })
          .eq('tenant_id', tid).eq('activo', true),
        supabase.from('horarios_recurrentes').select('id', { count: 'exact', head: true })
          .eq('tenant_id', tid).eq('activo', true),
        supabase.from('tiers').select('id', { count: 'exact', head: true })
          .eq('tenant_id', tid).eq('activo', true).gt('precio_centavos', 0),
        supabase.from('instructores').select('id', { count: 'exact', head: true })
          .eq('tenant_id', tid).eq('activo', true)
      ]);

      if (!mounted) return;

      const branding = (tenant.branding ?? {}) as Record<string, unknown>;
      const marca =
        (typeof branding.logo_url === 'string' && branding.logo_url.trim().length > 0);

      setSetup({
        sala: (sala.count ?? 0) > 0,
        horarios: (horarios.count ?? 0) > 0,
        plan: (plan.count ?? 0) > 0,
        instructor: (instructor.count ?? 0) > 0,
        marca
      });
      setIsLoading(false);
    }

    void load();
    return () => { mounted = false; };
  }, [tenant.id, tenant.branding, tick]);

  return { setup, isLoading, refetch };
}

/** Los 3 esenciales completos = el estudio ya puede operar. */
export function gymOperativo(s: GymSetup | null): boolean {
  return !!s && s.sala && s.horarios && s.plan;
}
