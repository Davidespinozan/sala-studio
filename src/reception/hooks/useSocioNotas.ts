import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

export interface SocioNota {
  id: string;
  autor_nombre: string | null;
  autor_rol: string | null;
  texto: string;
  creado_en: string;
}

/**
 * Notas de recepción sobre un socio (tabla socio_notas, append-only con autor).
 * Solo staff las lee (RLS). Se agregan vía recepcion_agregar_nota.
 */
export function useSocioNotas(usuarioId: string | undefined) {
  const [notas, setNotas] = useState<SocioNota[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!usuarioId) {
      setNotas([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    // socio_notas no está en los tipos generados → cast.
    const from = supabase.from.bind(supabase) as unknown as (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          order: (col: string, opts: { ascending: boolean }) => PromiseLike<{ data: SocioNota[] | null }>;
        };
      };
    };
    const { data } = await from('socio_notas')
      .select('id, autor_nombre, autor_rol, texto, creado_en')
      .eq('usuario_id', usuarioId)
      .order('creado_en', { ascending: false });
    setNotas(data ?? []);
    setIsLoading(false);
  }, [usuarioId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { notas, isLoading, refetch };
}
