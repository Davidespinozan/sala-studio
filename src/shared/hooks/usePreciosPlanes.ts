import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

/** Precio de UN plan para UN socio, ya con su descuento vigente (si aplica). */
export interface PrecioPlan {
  tier_id: string;
  precio_lista_centavos: number;
  descuento_centavos: number;
  precio_final_centavos: number;
  moneda: string;
  /** "Estudiante -20%". null = este plan no lleva descuento para este socio. */
  etiqueta: string | null;
  vence_el: string | null;
}

/**
 * Precios de los planes del gym PARA un socio (RPC precios_planes_para_socio).
 *
 * La regla del descuento vive en la base (_precio_plan_para_socio) y es la misma
 * que usa el cobro: lo que se pinta aquí es lo que se cobra. No recalcular el
 * porcentaje en el navegador.
 *
 * `canal`: 'recepcion' (mostrador/admin) o 'app' (el socio compra con Stripe; ahí
 * las mensualidades con cobro automático no llevan descuento).
 *
 * Si la consulta falla, `precioDe` devuelve null y quien llama cae al precio de
 * lista para PINTAR — el cobro en recepción lo calcula la base de todos modos.
 */
export function usePreciosPlanes(
  usuarioId: string | null | undefined,
  canal: 'recepcion' | 'app' = 'recepcion',
  enabled = true
) {
  const [precios, setPrecios] = useState<Map<string, PrecioPlan>>(new Map());
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!enabled || !usuarioId) {
      setPrecios(new Map());
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    // RPC no incluido aún en los tipos generados de Supabase.
    const { data, error } = await supabase.rpc('precios_planes_para_socio' as never, {
      p_usuario_id: usuarioId,
      p_canal: canal
    } as never);
    if (error) console.error('[usePreciosPlanes]', error.message);
    const filas = (Array.isArray(data) ? data : []) as PrecioPlan[];
    setPrecios(new Map(filas.filter(Boolean).map((p) => [p.tier_id, p])));
    setIsLoading(false);
  }, [usuarioId, canal, enabled]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const precioDe = useCallback(
    (tierId: string | null | undefined): PrecioPlan | null =>
      tierId ? precios.get(tierId) ?? null : null,
    [precios]
  );

  return { precioDe, isLoading, refetch };
}
