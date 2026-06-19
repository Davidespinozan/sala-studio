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
import { useAuth } from '@shared/hooks/useAuth';
import type { Database } from '@shared/types/database';

type Sucursal = Database['public']['Tables']['sucursales']['Row'];

interface ReceptionSucursalContextValue {
  /** Sede en la que opera la recepción. FIJA para recepción; el admin puede cambiarla. */
  sucursalId: string | null;
  sucursalNombre: string | null;
  /** Sedes activas del tenant (para etiquetar socios de otra sede y para el switcher de admin). */
  sucursales: { id: string; nombre: string }[];
  /** El usuario puede cambiar de sede (solo admin en multisede). */
  puedeCambiar: boolean;
  setSucursalId: (id: string) => void;
  /** true sólo con 2+ sedes: recién ahí se muestra la barra/selector de sede. */
  multisede: boolean;
}

const Ctx = createContext<ReceptionSucursalContextValue | null>(null);

/**
 * Sede de la RECEPCIÓN. A diferencia del socio, no hay switcher: la recepción
 * opera en UNA sede, la que el admin le asignó (usuarios.sucursal_id). Si no
 * tiene una asignada (recepción demo, legacy), cae a la sede por defecto del
 * tenant (la de menor orden). Con 1 sede, multisede=false y todo es transparente.
 */
function storageKey(tenantId: string): string {
  return `sala-recepcion-sucursal-${tenantId}`;
}

export function ReceptionSucursalProvider({ children }: { children: ReactNode }) {
  const tenant = useTenant();
  const { usuario } = useAuth();
  const home = usuario?.sucursal_id ?? null;
  const esAdmin = usuario?.rol === 'admin';

  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [sucursalId, setSucursalIdState] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from('sucursales')
        .select('*')
        .eq('tenant_id', tenant.id)
        .eq('activa', true)
        .order('orden', { ascending: true })
        .order('created_at', { ascending: true });
      if (!mounted) return;
      if (error) {
        console.error('[ReceptionSucursalProvider]', error);
        return;
      }
      const lista = data ?? [];
      setSucursales(lista);
      // El admin puede haber elegido otra sede (persistida). La recepción va fija
      // a su sede "home". En ambos casos caemos a la primera si nada calza.
      let elegida: string | null = null;
      if (esAdmin) {
        try {
          const stored = localStorage.getItem(storageKey(tenant.id));
          if (stored && lista.some((s) => s.id === stored)) elegida = stored;
        } catch {
          // ignore
        }
      }
      if (!elegida && home && lista.some((s) => s.id === home)) elegida = home;
      if (!elegida) elegida = lista[0]?.id ?? null;
      setSucursalIdState(elegida);
    }
    void load();
    return () => {
      mounted = false;
    };
  }, [tenant.id, home, esAdmin]);

  const multisede = sucursales.length > 1;
  const puedeCambiar = esAdmin && multisede;

  const setSucursalId = useCallback(
    (id: string) => {
      if (!esAdmin) return; // la recepción no cambia de sede
      setSucursalIdState(id);
      try {
        localStorage.setItem(storageKey(tenant.id), id);
      } catch {
        // ignore quota / private mode
      }
    },
    [esAdmin, tenant.id]
  );

  const sucursalNombre = sucursales.find((s) => s.id === sucursalId)?.nombre ?? null;

  const value: ReceptionSucursalContextValue = {
    sucursalId,
    sucursalNombre,
    sucursales: sucursales.map((s) => ({ id: s.id, nombre: s.nombre })),
    puedeCambiar,
    setSucursalId,
    multisede
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReceptionSucursal(): ReceptionSucursalContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useReceptionSucursal() llamado fuera de <ReceptionSucursalProvider>');
  return ctx;
}
