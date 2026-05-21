import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import type { Database } from '@shared/types/database';

export type Sucursal = Database['public']['Tables']['sucursales']['Row'];

interface SucursalContextValue {
  /** Sucursales activas del tenant, ordenadas. Alimenta el selector. */
  sucursales: Sucursal[];
  /** Sucursal seleccionada. null solo si el tenant no tiene ninguna activa. */
  sucursalActiva: Sucursal | null;
  /** Atajo a sucursalActiva?.id. Las queries del admin filtran por este id. */
  sucursalId: string | null;
  setSucursalActivaId: (id: string) => void;
  /** true cuando el tenant tiene >1 sucursal: recién ahí se muestra el selector. */
  multisede: boolean;
  refetch: () => Promise<void>;
}

const SucursalContext = createContext<SucursalContextValue | null>(null);

function storageKey(tenantId: string): string {
  return `sala-admin-sucursal-${tenantId}`;
}

function readStored(tenantId: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(storageKey(tenantId));
  } catch {
    return null;
  }
}

function writeStored(tenantId: string, sucursalId: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey(tenantId), sucursalId);
  } catch {
    // ignore quota / modo privado
  }
}

/**
 * Resuelve las sucursales del tenant y mantiene la sucursal "activa" del admin.
 *
 * El modelo de datos garantiza ≥1 sucursal por tenant (migración multisede-1).
 * Para Starter/Pro siempre hay exactamente una y el selector queda oculto
 * (multisede=false): el scoping por sucursal es transparente. Business puede
 * tener N y elegir cuál está viendo.
 */
export function SucursalProvider({ children }: { children: ReactNode }) {
  const tenant = useTenant();
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [sucursalId, setSucursalId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    const { data, error } = await supabase
      .from('sucursales')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('activa', true)
      .order('orden', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[SucursalProvider]', error);
      setIsLoading(false);
      return;
    }

    const lista = data ?? [];
    setSucursales(lista);
    setSucursalId((prev) => {
      // Mantener la selección actual si sigue siendo válida.
      if (prev && lista.some((s) => s.id === prev)) return prev;
      const stored = readStored(tenant.id);
      if (stored && lista.some((s) => s.id === stored)) return stored;
      return lista[0]?.id ?? null;
    });
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const setSucursalActivaId = useCallback(
    (id: string) => {
      setSucursalId(id);
      writeStored(tenant.id, id);
    },
    [tenant.id]
  );

  if (isLoading) {
    return <LoadingScreen />;
  }

  const sucursalActiva = sucursales.find((s) => s.id === sucursalId) ?? null;

  const value: SucursalContextValue = {
    sucursales,
    sucursalActiva,
    sucursalId,
    setSucursalActivaId,
    multisede: sucursales.length > 1,
    refetch
  };

  return <SucursalContext.Provider value={value}>{children}</SucursalContext.Provider>;
}

export function useSucursal(): SucursalContextValue {
  const ctx = useContext(SucursalContext);
  if (!ctx) {
    throw new Error('useSucursal() llamado fuera de <SucursalProvider>');
  }
  return ctx;
}
