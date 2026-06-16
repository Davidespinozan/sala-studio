import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';
import { useVisibilityAwarePolling } from '@shared/hooks/useVisibilityAwarePolling';

export interface Notificacion {
  id: string;
  tipo: string;
  titulo: string;
  mensaje: string;
  metadata: Record<string, unknown> | null;
  creada_at: string;
  leida: boolean;
}

const LIMITE = 20;
const POLL_MS = 30_000;

/**
 * Centro de notificaciones del usuario actual (socio, admin o recepción).
 * Trae las últimas N (leídas y no leídas) y refresca con polling
 * visibility-aware (pausa en background, refetch inmediato al volver al
 * foreground) — sistema "vivo" sin depender de realtime habilitado en la DB.
 */
export function useNotificaciones() {
  const { usuario } = useAuth();
  const [items, setItems] = useState<Notificacion[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!usuario) {
      setItems([]);
      setIsLoading(false);
      return;
    }
    const { data, error: err } = await supabase
      .from('notificaciones')
      .select('id, tipo, titulo, mensaje, metadata, creada_at, leida')
      .eq('usuario_id', usuario.id)
      .order('creada_at', { ascending: false })
      .limit(LIMITE);

    if (err) {
      setError('No pudimos cargar tus notificaciones.');
      setIsLoading(false);
      return;
    }
    setError(null);
    setItems((data ?? []) as Notificacion[]);
    setIsLoading(false);
  }, [usuario]);

  useEffect(() => { void refetch(); }, [refetch]);
  useVisibilityAwarePolling(refetch, POLL_MS);

  // Realtime: si está habilitado en la DB, las notificaciones aparecen al
  // instante (sin esperar el poll). Si no lo está, no pasa nada — el polling
  // sigue cubriendo. Suscribe solo a las del usuario actual (la RLS además
  // garantiza que solo reciba las suyas).
  useEffect(() => {
    if (!usuario) return;
    const channel = supabase
      .channel(`notificaciones-${usuario.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notificaciones', filter: `usuario_id=eq.${usuario.id}` },
        (payload) => {
          const n = payload.new as unknown as Notificacion;
          setItems((prev) => (prev.some((x) => x.id === n.id) ? prev : [n, ...prev].slice(0, LIMITE)));
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'notificaciones', filter: `usuario_id=eq.${usuario.id}` },
        (payload) => {
          const n = payload.new as unknown as Notificacion;
          setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, ...n } : x)));
        }
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [usuario]);

  const noLeidas = items.filter((n) => !n.leida).length;

  const marcarLeida = useCallback(async (id: string) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, leida: true } : n)));
    const { error: err } = await supabase
      .from('notificaciones')
      .update({ leida: true, leida_at: new Date().toISOString() })
      .eq('id', id);
    if (err) void refetch(); // revertir al estado real
  }, [refetch]);

  const marcarTodasLeidas = useCallback(async () => {
    if (!usuario) return;
    const ids = items.filter((n) => !n.leida).map((n) => n.id);
    if (ids.length === 0) return;
    setItems((prev) => prev.map((n) => ({ ...n, leida: true })));
    const { error: err } = await supabase
      .from('notificaciones')
      .update({ leida: true, leida_at: new Date().toISOString() })
      .eq('usuario_id', usuario.id)
      .eq('leida', false);
    if (err) void refetch();
  }, [usuario, items, refetch]);

  return { items, noLeidas, isLoading, error, marcarLeida, marcarTodasLeidas, refetch };
}
