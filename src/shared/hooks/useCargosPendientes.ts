import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';

export interface CargoPendiente {
  id: string;
  usuario_id: string;
  sucursal_id: string | null;
  concepto: string;
  descripcion: string | null;
  monto_centavos: number;
  created_at: string;
  socio_nombre: string | null;
  socio_email: string | null;
}

/**
 * Cargos "Por cobrar" (cargos_pendientes en estado 'pendiente'): planes o pases
 * que se activaron con "Pendiente (pagar al llegar)". Se cobran con
 * cobrar_cargo_pendiente, nunca renovando otra vez el plan (eso duplica clases y
 * vigencia — caso Annie / The Core, oct 2026). RLS: solo recepción/admin.
 *
 * Sin `usuarioId` → todos los del tenant (panel de Hoy, filtro de Socios).
 * Con `usuarioId` → solo los de ese socio (ficha, modales de renovar/cambiar).
 * `enabled=false` → no consulta (modal cerrado) y devuelve lista vacía.
 */
export function useCargosPendientes(usuarioId?: string, enabled = true) {
  const tenant = useTenant();
  const [cargos, setCargos] = useState<CargoPendiente[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!enabled) {
      setCargos([]);
      setIsLoading(false);
      return;
    }
    // cargos_pendientes aún no está en los tipos generados → cast del builder.
    type Builder = {
      eq: (c: string, v: unknown) => Builder;
      order: (c: string, o: { ascending: boolean }) => Promise<{ data: unknown[] | null }>;
    };
    const from = supabase.from.bind(supabase) as unknown as (t: string) => {
      select: (s: string) => Builder;
    };
    let q = from('cargos_pendientes')
      .select(
        'id, usuario_id, sucursal_id, concepto, descripcion, monto_centavos, created_at, ' +
          'socio:usuarios!cargos_pendientes_usuario_id_fkey(nombre, email)'
      )
      .eq('tenant_id', tenant.id)
      .eq('estado', 'pendiente');
    if (usuarioId) q = q.eq('usuario_id', usuarioId);
    const { data } = await q.order('created_at', { ascending: true });

    setCargos(
      (data ?? []).map((row) => {
        const r = row as Omit<CargoPendiente, 'socio_nombre' | 'socio_email'> & {
          socio?: { nombre?: string | null; email?: string | null } | null;
        };
        return {
          id: r.id,
          usuario_id: r.usuario_id,
          sucursal_id: r.sucursal_id,
          concepto: r.concepto,
          descripcion: r.descripcion,
          monto_centavos: r.monto_centavos,
          created_at: r.created_at,
          socio_nombre: r.socio?.nombre ?? null,
          socio_email: r.socio?.email ?? null
        };
      })
    );
    setIsLoading(false);
  }, [tenant.id, usuarioId, enabled]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const totalCentavos = cargos.reduce((acc, c) => acc + c.monto_centavos, 0);

  return { cargos, totalCentavos, isLoading, refetch };
}
