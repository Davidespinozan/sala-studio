import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';

/**
 * Los planes del gym, para poder mostrar el NOMBRE de un plan a partir del slug
 * que traen los usuarios (`usuarios.membresia_tier` guarda el slug, no el nombre).
 *
 * Existe porque varias pantallas resolvían eso a mano comparando contra los slugs
 * de los planes de EJEMPLO del onboarding:
 *
 *     miembro.membresia_tier === 'pro' ? 'PRO' : ... : 'SIN PLAN'
 *
 * En un gym real, cuyos planes se llaman "Mensual" o "Anual", eso etiquetaba a
 * TODO socio con membresía activa como "SIN PLAN" — y en el check-in eso es un
 * socio al que la recepción puede rebotar en la puerta.
 *
 * Incluye los planes archivados: un socio puede seguir teniendo un plan viejo que
 * el gym ya no vende, y su nombre igual hay que poder mostrarlo.
 */
export interface PlanDelTenant {
  slug: string;
  nombre: string;
  activo: boolean;
}

export function usePlanesDelTenant() {
  const tenant = useTenant();
  const [planes, setPlanes] = useState<Map<string, PlanDelTenant>>(new Map());
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let vivo = true;

    async function load() {
      const { data, error } = await supabase
        .from('tiers')
        .select('slug, nombre, activo')
        .eq('tenant_id', tenant.id);

      if (!vivo) return;

      if (error) {
        // Sin planes no se inventa nada: la UI cae a "sin plan asignado", que es
        // honesto. Antes se caía a los planes de ejemplo, que es peor que nada.
        console.error('[usePlanesDelTenant]', error);
        setPlanes(new Map());
      } else {
        setPlanes(new Map((data ?? []).map((t) => [t.slug, t as PlanDelTenant])));
      }
      setIsLoading(false);
    }

    void load();
    return () => {
      vivo = false;
    };
  }, [tenant.id]);

  /**
   * Nombre visible del plan de un socio. `null` significa que el socio no tiene
   * plan; un slug que no está en la lista se muestra tal cual (mejor mostrar el
   * dato crudo que mentir con un "SIN PLAN" que haría que lo rebotaran).
   */
  function nombrePlan(slug: string | null | undefined): string | null {
    if (!slug) return null;
    return planes.get(slug)?.nombre ?? slug;
  }

  return { planes, nombrePlan, isLoading };
}
