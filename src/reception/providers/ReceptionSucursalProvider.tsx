import {
  createContext,
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
  /** Sede en la que opera la recepción. FIJA (no hay switcher). */
  sucursalId: string | null;
  sucursalNombre: string | null;
  /** true sólo con 2+ sedes: recién ahí se muestra la barra de sede. */
  multisede: boolean;
}

const Ctx = createContext<ReceptionSucursalContextValue | null>(null);

/**
 * Sede de la RECEPCIÓN. A diferencia del socio, no hay switcher: la recepción
 * opera en UNA sede, la que el admin le asignó (usuarios.sucursal_id). Si no
 * tiene una asignada (recepción demo, legacy), cae a la sede por defecto del
 * tenant (la de menor orden). Con 1 sede, multisede=false y todo es transparente.
 */
export function ReceptionSucursalProvider({ children }: { children: ReactNode }) {
  const tenant = useTenant();
  const { usuario } = useAuth();
  const home = usuario?.sucursal_id ?? null;

  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [sucursalId, setSucursalId] = useState<string | null>(null);

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
      setSucursalId(home && lista.some((s) => s.id === home) ? home : lista[0]?.id ?? null);
    }
    void load();
    return () => {
      mounted = false;
    };
  }, [tenant.id, home]);

  const sucursalNombre = sucursales.find((s) => s.id === sucursalId)?.nombre ?? null;

  const value: ReceptionSucursalContextValue = {
    sucursalId,
    sucursalNombre,
    multisede: sucursales.length > 1
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReceptionSucursal(): ReceptionSucursalContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useReceptionSucursal() llamado fuera de <ReceptionSucursalProvider>');
  return ctx;
}
