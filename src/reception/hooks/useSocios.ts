import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useReceptionSucursal } from '../providers/ReceptionSucursalProvider';
import { translateReadError } from '../lib/traducirErrorLectura';

/** Item de la lista de socios (buscador de recepción). Solo lectura. */
export interface SocioListItem {
  id: string;
  nombre: string | null;
  email: string;
  telefono: string | null;
  avatar_url: string | null;
  membresia_tier: string | null;
  status: string;
}

// Normaliza para búsqueda insensible a acentos: "José" ≈ "Jose". Postgres ilike
// NO ignora diacríticos, por eso el filtrado es en cliente (no server-side).
const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/**
 * Buscador de socios (read-only). Carga el padrón completo del tenant UNA vez
 * al montar (RLS ya scopea por tenant: usuarios_read_admin acepta recepción) y
 * filtra EN CLIENTE con normalización NFD — así "Jose" encuentra "José", cosa
 * que ilike de Postgres no hace.
 *
 * LIMITACIÓN DE ESCALA: la carga tiene `limit(1000)`. Para gyms boutique
 * (100-500 socios típico) sobra. Si algún tenant supera los 1000 socios, el
 * filtrado client-side no encontrará a los del lugar 1001+; en ese caso habrea
 * que volver a un buscador server-side (con unaccent/trigram en Postgres) o
 * paginar. Aceptable por ahora.
 */
export function useSocios(query: string) {
  const { sucursalId } = useReceptionSucursal();
  const [padron, setPadron] = useState<SocioListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Carga del padrón de la sede de la recepción (recarga si cambia la sede).
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    (async () => {
      let q = supabase
        .from('usuarios')
        .select('id, nombre, email, telefono, avatar_url, membresia_tier, status')
        .eq('rol', 'miembro')
        .order('nombre', { ascending: true })
        .limit(1000);

      if (sucursalId) q = q.eq('sucursal_id', sucursalId);

      const { data, error: queryError } = await q;

      if (cancelled) return;
      if (queryError) {
        setError(translateReadError(queryError));
        setPadron([]);
      } else {
        setError(null);
        setPadron((data ?? []) as SocioListItem[]);
      }
      setIsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [sucursalId]);

  // Filtrado local instantáneo (solo CPU, sin debounce ni race conditions).
  const socios = useMemo(() => {
    const term = query.trim();
    if (!term) return padron.slice(0, 30); // sin query → primeros 30
    const q = normalize(term);
    return padron
      .filter((s) => {
        if (normalize(s.nombre ?? '').includes(q)) return true;
        if (normalize(s.email ?? '').includes(q)) return true;
        // Teléfono sin normalizar (los números no tienen acentos).
        if ((s.telefono ?? '').includes(term)) return true;
        return false;
      })
      .slice(0, 50); // tope 50 (más amplio que server-side porque es local)
  }, [padron, query]);

  return { socios, isLoading, error };
}
