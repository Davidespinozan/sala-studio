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

/** Valor del selector para "ver todas las sedes juntas". */
export const TODAS_SEDES = 'todas';

interface SucursalContextValue {
  /** Sucursales activas del tenant, ordenadas. Alimenta el selector. */
  sucursales: Sucursal[];
  /**
   * Sucursal OPERATIVA: siempre una sede real (nunca null si el tenant tiene
   * sedes). Las pantallas de GESTIÓN (crear salas, horarios, instructores)
   * trabajan sobre esta — crear algo necesita una sede concreta, aunque el
   * dueño esté mirando "Todas" en análisis.
   */
  sucursalActiva: Sucursal | null;
  /** Atajo a la sede operativa. Gestión filtra/crea por acá. */
  sucursalId: string | null;
  /**
   * Filtro para ANÁLISIS (Reportes, Caja, Dashboard): el id de la sede elegida,
   * o `null` cuando es "Todas las sedes" O cuando el gym tiene una sola sede.
   * `null` = no filtrar = todo el gimnasio. Nunca filtra de más.
   */
  sucursalFiltro: string | null;
  /** true cuando el dueño eligió "Todas las sedes" (solo posible en multisede). */
  esTodas: boolean;
  /** Acepta un id real, o TODAS_SEDES para el modo agregado. */
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

function writeStored(tenantId: string, value: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey(tenantId), value);
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
 * tener N, elegir cuál está viendo, o "Todas las sedes" para el agregado.
 *
 * Dos ejes a propósito distintos:
 *   - `sucursalId` (operativa) NUNCA es null si hay sedes: gestión necesita una.
 *   - `sucursalFiltro` (análisis) es null en "Todas" o mono-sede: no filtrar.
 * Elegir "Todas" no borra la sede operativa; la gestión sigue en la última real.
 */
export function SucursalProvider({ children }: { children: ReactNode }) {
  const tenant = useTenant();
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  // La sede operativa (real). Nunca la ponemos en null salvo que no haya sedes.
  const [sucursalId, setSucursalId] = useState<string | null>(null);
  // El dueño está viendo "Todas las sedes" en las pantallas de análisis.
  const [todas, setTodas] = useState(false);
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

    const stored = readStored(tenant.id);
    // "Todas" solo tiene sentido con más de una sede.
    setTodas(stored === TODAS_SEDES && lista.length > 1);
    setSucursalId((prev) => {
      if (prev && lista.some((s) => s.id === prev)) return prev;
      if (stored && stored !== TODAS_SEDES && lista.some((s) => s.id === stored)) return stored;
      return lista[0]?.id ?? null;
    });
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const setSucursalActivaId = useCallback(
    (id: string) => {
      if (id === TODAS_SEDES) {
        setTodas(true);
        writeStored(tenant.id, TODAS_SEDES);
        return;
      }
      // Elegir una sede real: sale de "Todas" y fija la sede operativa.
      setTodas(false);
      setSucursalId(id);
      writeStored(tenant.id, id);
    },
    [tenant.id]
  );

  if (isLoading) {
    return <LoadingScreen />;
  }

  const multisede = sucursales.length > 1;
  const esTodas = multisede && todas;
  const sucursalActiva = sucursales.find((s) => s.id === sucursalId) ?? null;
  // Solo filtramos análisis cuando hay VARIAS sedes y NO estamos en "Todas".
  const sucursalFiltro = multisede && !todas ? sucursalId : null;

  const value: SucursalContextValue = {
    sucursales,
    sucursalActiva,
    sucursalId,
    sucursalFiltro,
    esTodas,
    setSucursalActivaId,
    multisede,
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
