import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';
import { traducirErrorRPC } from '@member/logic/reservaLogic';

/** Estado del miembro respecto a la lista de espera de una clase concreta. */
export interface MiPosicionEspera {
  en_lista: boolean;
  posicion: number | null;
  lista_espera_id: string | null;
  total: number;
  promovido: boolean;
  reserva_id: string | null;
}

/** Una entrada de la lista de espera del miembro, con datos de la clase. */
export interface ListaEsperaItem {
  lista_espera_id: string;
  clase_id: string;
  created_at: string;
  nombre: string;
  disciplina: string | null;
  fecha: string;
  hora_inicio: string;
  duracion_minutos: number;
  cupo_max: number;
  posicion: number;
}

/** Anota al miembro en la lista de espera. Modelo virtual: por claseId si está
 *  materializada, o por horarioId+fecha (anotar_lista_espera_virtual materializa). */
export async function anotarseEnListaEspera(params: {
  claseId?: string | null;
  horarioId?: string | null;
  fecha?: string;
}): Promise<{ posicion: number }> {
  // anotar_lista_espera_virtual no está en los tipos generados → cast.
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message: string } | null }>;

  const { data, error } = params.claseId
    ? await rpc('anotar_lista_espera', { p_clase_id: params.claseId })
    : await rpc('anotar_lista_espera_virtual', {
        p_horario_id: params.horarioId,
        p_fecha: params.fecha
      });
  if (error) throw new Error(traducirErrorRPC(error.message));
  return { posicion: (data as { posicion: number }).posicion };
}

/** Saca al miembro actual de la lista de espera de una clase. */
export async function salirDeListaEspera(claseId: string): Promise<void> {
  const { error } = await supabase.rpc('salir_lista_espera', { p_clase_id: claseId });
  if (error) throw new Error(traducirErrorRPC(error.message));
}

/** Devuelve la posición/estado del miembro en la lista de espera de una clase. */
export async function miPosicionEnLista(claseId: string): Promise<MiPosicionEspera> {
  const { data, error } = await supabase.rpc('mi_posicion_lista_espera', { p_clase_id: claseId });
  if (error) throw new Error(traducirErrorRPC(error.message));
  return data as unknown as MiPosicionEspera;
}

/** Lista todas las clases donde el miembro actual está esperando. */
export function useMisListasEspera() {
  const { usuario } = useAuth();
  const [items, setItems] = useState<ListaEsperaItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!usuario) {
      setItems([]);
      setIsLoading(false);
      return;
    }
    const { data, error } = await supabase.rpc('mis_listas_espera');
    if (error) {
      console.error('[useMisListasEspera]', error);
      setIsLoading(false);
      return;
    }
    setItems((data ?? []) as unknown as ListaEsperaItem[]);
    setIsLoading(false);
  }, [usuario]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { items, isLoading, refetch };
}
