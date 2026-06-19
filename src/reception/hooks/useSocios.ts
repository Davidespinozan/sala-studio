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
  sucursal_id: string | null;
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

  // Carga el padrón COMPLETO del tenant (RLS ya scopea por tenant). El buscador
  // debe encontrar a cualquier socio — incluido uno con plan global que entrena
  // en otra sede —, así que no filtramos por sede acá; el filtro por sede se
  // aplica solo a la lista por defecto (abajo).
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    (async () => {
      const { data, error: queryError } = await supabase
        .from('usuarios')
        .select('id, nombre, email, telefono, avatar_url, membresia_tier, status, sucursal_id')
        .eq('rol', 'miembro')
        .order('nombre', { ascending: true })
        .limit(1000);

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
  }, []);

  // Filtrado local instantáneo (solo CPU, sin debounce ni race conditions).
  const socios = useMemo(() => {
    const term = query.trim();
    // Sin query → primeros 30 de ESTA sede (vista por defecto del mostrador).
    if (!term) {
      const deSede = sucursalId ? padron.filter((s) => s.sucursal_id === sucursalId) : padron;
      return deSede.slice(0, 30);
    }
    // Con query → busca en TODO el tenant (encuentra socios visitantes).
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
  }, [padron, query, sucursalId]);

  return { socios, isLoading, error };
}
