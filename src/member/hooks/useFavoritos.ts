import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { supabase } from '@shared/lib/supabase';

/**
 * Favoritas del socio: el conjunto de recursos (salas/disciplinas) que marcó
 * como favoritos, con un `toggle` optimista. Dato del propio socio (tabla
 * `favoritos`, RLS self-scoped). Cada uso del hook trae su propio set; para el
 * Home alcanza un count aparte (no hace falta cargar el set entero).
 */
export function useFavoritos() {
  const { usuario } = useAuth();
  const tenant = useTenant();
  const usuarioId = usuario?.id;
  const [favoritos, setFavoritos] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!usuarioId) {
      setLoading(false);
      return;
    }
    let mounted = true;
    async function load() {
      const { data } = await supabase
        .from('favoritos')
        .select('recurso_id')
        .eq('usuario_id', usuarioId!);
      if (!mounted) return;
      setFavoritos(new Set((data ?? []).map((r) => r.recurso_id)));
      setLoading(false);
    }
    void load();
    return () => {
      mounted = false;
    };
  }, [usuarioId]);

  const toggle = useCallback(
    async (recursoId: string) => {
      if (!usuario?.id) return;
      const eraFavorito = favoritos.has(recursoId);

      // Optimista: actualizamos la UI ya y revertimos si el server falla.
      setFavoritos((prev) => {
        const next = new Set(prev);
        if (eraFavorito) next.delete(recursoId);
        else next.add(recursoId);
        return next;
      });

      const { error } = eraFavorito
        ? await supabase
            .from('favoritos')
            .delete()
            .eq('usuario_id', usuario.id)
            .eq('recurso_id', recursoId)
        : await supabase
            .from('favoritos')
            .insert({ tenant_id: tenant.id, usuario_id: usuario.id, recurso_id: recursoId });

      if (error) {
        setFavoritos((prev) => {
          const next = new Set(prev);
          if (eraFavorito) next.add(recursoId);
          else next.delete(recursoId);
          return next;
        });
      }
    },
    [usuario?.id, tenant.id, favoritos]
  );

  return {
    favoritos,
    loading,
    toggle,
    isFavorito: (recursoId: string) => favoritos.has(recursoId),
    count: favoritos.size
  };
}
