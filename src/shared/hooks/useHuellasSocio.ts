import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

export interface HuellaSocio {
  id: string;
  dedo: string;
  calidad: number | null;
  created_at: string;
}

/**
 * Las huellas VIVAS de un socio.
 *
 * Ojo con el select: NO se puede pedir `*`. La columna `plantilla` tiene el
 * permiso revocado para `authenticated` (la huella no sale por la API, ni para el
 * admin), así que un `select=*` devuelve "permission denied". Pedimos por nombre.
 *
 * Lo usan las tres superficies: recepción (¿ya tiene huella?), el socio (¿tengo
 * una registrada?) y el admin.
 */
export function useHuellasSocio(usuarioId: string | undefined) {
  const [huellas, setHuellas] = useState<HuellaSocio[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!usuarioId) {
      setHuellas([]);
      setIsLoading(false);
      return;
    }
    const { data } = await supabase
      .from('credenciales_biometricas')
      .select('id, dedo, calidad, created_at')
      .eq('usuario_id', usuarioId)
      .is('revocada_at', null)
      .order('created_at', { ascending: true });

    setHuellas((data ?? []) as HuellaSocio[]);
    setIsLoading(false);
  }, [usuarioId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { huellas, isLoading, refetch };
}
