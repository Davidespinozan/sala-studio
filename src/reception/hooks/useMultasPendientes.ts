import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';

export interface MultaPendienteHoy {
  /** id de la reserva que generó la multa. */
  id: string;
  folio: string | null;
  slot_inicio: string;
  multa_centavos: number;
  socio_id: string | null;
  socio_nombre: string | null;
  socio_email: string | null;
  recurso_nombre: string | null;
}

/**
 * Todas las multas pendientes del tenant (reservas con multa_centavos>0 y
 * multa_pagada=false), para verlas y cobrarlas desde "Hoy". Antes solo aparecían
 * escondidas en la ficha del socio y en Caja. Scope de tenant por RLS. Las de
 * "faltar" viven en reservas pasadas ya marcadas no_show, por eso no salían en la
 * agenda del día.
 */
export function useMultasPendientes() {
  const tenant = useTenant();
  const [multas, setMultas] = useState<MultaPendienteHoy[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    // multa_centavos/multa_pagada aún no están en los tipos generados → cast del builder.
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
      .select(
        'id, folio, slot_inicio, multa_centavos, ' +
          'recurso:recursos(nombre), ' +
          'usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email)'
      )
      .eq('tenant_id', tenant.id)
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
          usuario?: { id?: string | null; nombre?: string | null; email?: string | null } | null;
        };
        return {
          id: r.id,
          folio: r.folio,
          slot_inicio: r.slot_inicio,
          multa_centavos: r.multa_centavos,
          socio_id: r.usuario?.id ?? null,
          socio_nombre: r.usuario?.nombre ?? null,
          socio_email: r.usuario?.email ?? null,
          recurso_nombre: r.recurso?.nombre ?? null
        };
      })
    );
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const totalCentavos = multas.reduce((acc, m) => acc + m.multa_centavos, 0);

  return { multas, totalCentavos, isLoading, refetch };
}
