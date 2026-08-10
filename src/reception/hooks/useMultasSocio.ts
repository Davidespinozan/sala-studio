import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

export interface MultaPendiente {
  /** id de la reserva que generó la multa. */
  id: string;
  folio: string | null;
  slot_inicio: string;
  multa_centavos: number;
  recurso_nombre: string | null;
}

/**
 * Multas pendientes de un socio (de cualquier reserva, no solo las de hoy): las
 * del Modelo B (faltar) viven en reservas pasadas ya marcadas no_show, así que la
 * ficha las cobra aquí cuando el socio llega. Reusa reservas.multa_centavos.
 */
export function useMultasSocio(socioId: string) {
  const [multas, setMultas] = useState<MultaPendiente[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    // multa_centavos/multa_pagada aún no están en los tipos generados → cast.
    const q = supabase.from('reservas') as unknown as {
      select: (s: string) => {
        eq: (c: string, v: unknown) => {
          gt: (c: string, v: number) => {
            eq: (c: string, v: unknown) => {
              order: (c: string, o: { ascending: boolean }) => Promise<{ data: unknown[] | null }>;
            };
          };
        };
      };
    };
    const { data } = await q
      .select('id, folio, slot_inicio, multa_centavos, recurso:recursos(nombre)')
      .eq('usuario_id', socioId)
      .gt('multa_centavos', 0)
      .eq('multa_pagada', false)
      .order('slot_inicio', { ascending: false });

    setMultas(
      (data ?? []).map((row) => {
        const r = row as {
          id: string;
          folio: string | null;
          slot_inicio: string;
          multa_centavos: number;
          recurso?: { nombre?: string | null } | null;
        };
        return {
          id: r.id,
          folio: r.folio,
          slot_inicio: r.slot_inicio,
          multa_centavos: r.multa_centavos,
          recurso_nombre: r.recurso?.nombre ?? null
        };
      })
    );
    setIsLoading(false);
  }, [socioId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { multas, isLoading, refetch };
}