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
import { useMembresiaActual } from '@member/hooks/useMembresiaActual';
import type { Database } from '@shared/types/database';

export type Sucursal = Database['public']['Tables']['sucursales']['Row'];

interface MemberSucursalContextValue {
  /** Sucursales activas del tenant. */
  sucursales: Sucursal[];
  /** Sucursal ACTIVA del socio (la que filtra clases/salas/instructores). */
  sucursalActiva: Sucursal | null;
  /** Atajo a sucursalActiva?.id. Las queries del socio filtran por este id. */
  sucursalId: string | null;
  setSucursalActivaId: (id: string) => void;
  /** true sólo con 2+ sedes: recién ahí se muestra el switcher. */
  multisede: boolean;
}

const Ctx = createContext<MemberSucursalContextValue | null>(null);

function storageKey(tenantId: string): string {
  return `sala-socio-sucursal-${tenantId}`;
}

/**
 * Sede ACTIVA del socio. Resolución: elección guardada (localStorage) → su sede
 * "home" (usuarios.sucursal_id) → primera del tenant. Cambiar de sede NO escribe
 * en DB (la membresía sirve en cualquier sede); sólo persiste la preferencia
 * local. Con 1 sede, multisede=false y el switcher queda oculto (transparente).
 */
export function MemberSucursalProvider({ children }: { children: ReactNode }) {
  const tenant = useTenant();
  const { usuario } = useAuth();
  const { membresia } = useMembresiaActual();
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
        console.error('[MemberSucursalProvider]', error);
        return;
      }
      const lista = data ?? [];
      setSucursales(lista);
      setSucursalId(() => {
        let stored: string | null = null;
        try {
          stored = localStorage.getItem(storageKey(tenant.id));
        } catch {
          // ignore
        }
        if (stored && lista.some((s) => s.id === stored)) return stored;
        if (home && lista.some((s) => s.id === home)) return home;
        return lista[0]?.id ?? null;
      });
    }
    void load();
    return () => {
      mounted = false;
    };
  }, [tenant.id, home]);

  const setSucursalActivaId = useCallback(
    (id: string) => {
      setSucursalId(id);
      try {
        localStorage.setItem(storageKey(tenant.id), id);
      } catch {
        // ignore quota / modo privado
      }
    },
    [tenant.id]
  );

  // Alcance del plan: si la membresía no da acceso a todas las sedes, el socio
  // solo ve (y reserva en) la sede a la que se suscribió. Mientras carga la
  // membresía, se asume acceso total (no parpadea ocultando de más).
  const todasSedes = membresia?.tier_acceso_todas_sucursales ?? true;
  const memSucursal = membresia?.sucursal_id ?? null;
  const visibles =
    todasSedes || !memSucursal ? sucursales : sucursales.filter((s) => s.id === memSucursal);

  // Si la sede elegida cae fuera del plan, forzamos la primera permitida.
  const sucursalIdSafe = visibles.some((s) => s.id === sucursalId)
    ? sucursalId
    : visibles[0]?.id ?? null;
  const sucursalActiva = visibles.find((s) => s.id === sucursalIdSafe) ?? null;

  const value: MemberSucursalContextValue = {
    sucursales: visibles,
    sucursalActiva,
    sucursalId: sucursalIdSafe,
    setSucursalActivaId,
    multisede: visibles.length > 1
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMemberSucursal(): MemberSucursalContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useMemberSucursal() llamado fuera de <MemberSucursalProvider>');
  return ctx;
}
