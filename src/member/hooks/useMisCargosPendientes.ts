import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';

export interface MiCargoPendiente {
  id: string;
  monto_centavos: number;
  concepto: string;
  descripcion: string | null;
  created_at: string;
}

/** Pagos pendientes del propio socio (plan activado "por cobrar"). La tabla
 *  cargos_pendientes solo la lee recepción por RLS: el socio pasa por la RPC. */
export function useMisCargosPendientes(): { cargos: MiCargoPendiente[]; total: number; refetch: () => Promise<void> } {
  const { usuario } = useAuth();
  const [cargos, setCargos] = useState<MiCargoPendiente[]>([]);
  const refetch = useCallback(async () => {
    if (!usuario?.id) { setCargos([]); return; }
    const { data, error } = await supabase.rpc('socio_cargos_pendientes' as never);
    if (error || !Array.isArray(data)) { setCargos([]); return; }
    setCargos(data as unknown as MiCargoPendiente[]);
  }, [usuario?.id]);
  useEffect(() => { void refetch(); }, [refetch]);
  return { cargos, total: cargos.reduce((n, c) => n + (c.monto_centavos ?? 0), 0), refetch };
}
