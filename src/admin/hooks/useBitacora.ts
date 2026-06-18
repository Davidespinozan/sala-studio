import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';

export interface BitacoraEntry {
  id: string;
  actor_nombre: string;
  actor_rol: string;
  accion: string;
  entidad: string | null;
  socio_nombre: string | null;
  resumen: string;
  detalle: Record<string, unknown> | null;
  creado_en: string;
}

// La tabla `auditoria_recepcion` no está en los tipos generados de supabase
// todavía → casteamos el query builder a una forma mínima tipada.
type BitacoraQuery = {
  select: (cols: string) => {
    eq: (col: string, val: string) => {
      order: (col: string, opts: { ascending: boolean }) => {
        limit: (n: number) => PromiseLike<{ data: BitacoraEntry[] | null; error: { message: string } | null }>;
      };
    };
  };
};

/**
 * Bitácora de recepción (auditoria_recepcion) del tenant. Solo admin la lee
 * (RLS audrec_read_admin). Read-only; la escriben los RPCs SECURITY DEFINER.
 */
export function useBitacora() {
  const tenant = useTenant();
  const [entries, setEntries] = useState<BitacoraEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    const from = supabase.from.bind(supabase) as unknown as (t: string) => BitacoraQuery;
    const { data, error: qErr } = await from('auditoria_recepcion')
      .select('id, actor_nombre, actor_rol, accion, entidad, socio_nombre, resumen, detalle, creado_en')
      .eq('tenant_id', tenant.id)
      .order('creado_en', { ascending: false })
      .limit(200);

    if (qErr) {
      setError('No pudimos cargar la bitácora.');
      setEntries([]);
    } else {
      setEntries(data ?? []);
    }
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { entries, isLoading, error, refetch };
}
