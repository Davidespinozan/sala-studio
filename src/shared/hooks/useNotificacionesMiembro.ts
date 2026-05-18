import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';

export interface Notificacion {
  id: string;
  tipo: string;
  titulo: string;
  mensaje: string;
  metadata: Record<string, unknown> | null;
  creada_at: string;
}

/**
 * Hook que lista notificaciones in-app no leídas del usuario actual.
 * Usado por el banner de notificaciones del member layout.
 */
export function useNotificacionesMiembro() {
  const { usuario } = useAuth();
  const [notificaciones, setNotificaciones] = useState<Notificacion[]>([]);

  const refetch = useCallback(async () => {
    if (!usuario) {
      setNotificaciones([]);
      return;
    }
    const { data, error } = await supabase
      .from('notificaciones')
      .select('id, tipo, titulo, mensaje, metadata, creada_at')
      .eq('usuario_id', usuario.id)
      .eq('leida', false)
      .order('creada_at', { ascending: false })
      .limit(5);

    if (error) {
      console.error('[useNotificacionesMiembro]', error);
      return;
    }
    setNotificaciones((data ?? []) as Notificacion[]);
  }, [usuario]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const marcarLeida = useCallback(async (id: string) => {
    await supabase
      .from('notificaciones')
      .update({ leida: true, leida_at: new Date().toISOString() })
      .eq('id', id);
    setNotificaciones((prev) => prev.filter((n) => n.id !== id));
  }, []);

  return { notificaciones, marcarLeida, refetch };
}
