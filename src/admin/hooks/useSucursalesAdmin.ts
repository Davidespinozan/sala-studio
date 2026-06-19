import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import type { Sucursal } from '../providers/SucursalProvider';

export interface SucursalFormData {
  nombre: string;
  direccion: string | null;
  timezone: string;
  activa: boolean;
  descripcion: string | null;
  foto_url: string | null;
}

/**
 * Todas las sucursales del tenant (activas + inactivas) para la página de
 * gestión. El selector global (SucursalProvider) carga solo las activas.
 */
export function useSucursalesAdmin() {
  const tenant = useTenant();
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from('sucursales')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('orden', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[useSucursalesAdmin]', error);
      setIsLoading(false);
      return;
    }
    setSucursales(data ?? []);
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { sucursales, isLoading, refetch };
}

export async function crearSucursal(
  tenantId: string,
  orden: number,
  data: SucursalFormData
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('sucursales')
    .insert({ tenant_id: tenantId, orden, ...data });
  return { error: error?.message ?? null };
}

export async function actualizarSucursal(
  id: string,
  data: Partial<SucursalFormData>
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('sucursales').update(data).eq('id', id);
  return { error: error?.message ?? null };
}
