import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import type { SalaLayout } from '@shared/lib/salaLayout';

/**
 * Mapa de Salón del lado socio: trae el `layout` de la sala y los lugares ya
 * tomados de la clase, para pintar el selector al reservar. Si la sala no tiene
 * layout, `layout` es null y la reserva sigue el flujo por cupo (sin lugar).
 *
 * `claseId` puede ser null cuando la clase aún es VIRTUAL (no materializada):
 * en ese caso no hay reservas todavía → ningún lugar tomado.
 *
 * Se usa `select('*')` + cast porque layout/lugar_id aún no están en los tipos
 * generados.
 */
export function useLugaresSala(
  recursoId: string | undefined,
  claseId: string | null | undefined
) {
  const [layout, setLayout] = useState<SalaLayout | null>(null);
  const [tomados, setTomados] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!recursoId) {
      setIsLoading(false);
      return;
    }
    let mounted = true;
    (async () => {
      setIsLoading(true);
      const { data: rec } = await supabase
        .from('recursos')
        .select('*')
        .eq('id', recursoId)
        .maybeSingle();
      const lay = (rec as { layout?: SalaLayout | null } | null)?.layout ?? null;

      let taken = new Set<string>();
      if (lay && claseId) {
        // RPC SECURITY DEFINER: la RLS reservas_read_self solo deja ver las
        // reservas propias, así que un select directo mostraría todos los
        // lugares libres. El RPC devuelve solo los lugar_id ocupados (sin quién).
        const { data: res } = await supabase.rpc('lugares_ocupados' as never, {
          p_clase_id: claseId
        } as never);
        taken = new Set(
          ((res ?? []) as unknown as { lugar_id: string | null }[])
            .map((r) => r.lugar_id)
            .filter((x): x is string => !!x)
        );
      }

      if (!mounted) return;
      setLayout(lay);
      setTomados(taken);
      setIsLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [recursoId, claseId]);

  return { layout, tomados, isLoading };
}
