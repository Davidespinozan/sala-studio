import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

export interface AuditoriaSocioEntry {
  id: string;
  actor_nombre: string;
  actor_rol: string;
  accion: string;
  entidad: string | null;
  resumen: string;
  creado_en: string;
}

// auditoria_recepcion no está en los tipos generados → cast mínimo del builder.
type SocioAuditQuery = {
  select: (cols: string) => {
    eq: (col: string, val: string) => {
      order: (col: string, opts: { ascending: boolean }) => {
        limit: (n: number) => PromiseLike<{
          data: AuditoriaSocioEntry[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

/**
 * Historial de cambios de UN socio (auditoria_recepcion filtrada por socio_id).
 * Read-only; lo escriben los RPCs recepcion_* (SECURITY DEFINER). Solo admin lo
 * lee (RLS audrec_read_admin) — por eso vive en el detalle de miembro del admin.
 */
export function useMiembroAuditoria(usuarioId: string | undefined) {
  const [entries, setEntries] = useState<AuditoriaSocioEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!usuarioId) {
      setEntries([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);

    const from = supabase.from.bind(supabase) as unknown as (t: string) => SocioAuditQuery;
    const { data, error: qErr } = await from('auditoria_recepcion')
      .select('id, actor_nombre, actor_rol, accion, entidad, resumen, creado_en')
      .eq('socio_id', usuarioId)
      .order('creado_en', { ascending: false })
      .limit(50);

    if (qErr) {
      setError('No pudimos cargar el historial.');
      setEntries([]);
    } else {
      setEntries(data ?? []);
    }
    setIsLoading(false);
  }, [usuarioId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { entries, isLoading, error, refetch };
}
