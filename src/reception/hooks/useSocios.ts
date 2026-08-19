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
  /** Llegó como invitado (ligado desde reserva_invitados). Para etiquetar "Invitado". */
  es_invitado: boolean;
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
  const [nonce, setNonce] = useState(0); // bump → recarga el padrón (tras alta)

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

      // Socios que llegaron como invitados (vínculo en reserva_invitados) → para
      // etiquetarlos "Invitado". Best-effort: si falla, nadie queda etiquetado.
      const { data: invRows } = await (supabase.from as unknown as (t: string) => {
        select: (c: string) => Promise<{ data: { usuario_id: string | null }[] | null }>;
      })('reserva_invitados').select('usuario_id');
      const invSet = new Set(((invRows ?? []).map((r) => r.usuario_id).filter(Boolean)) as string[]);

      if (cancelled) return;
      if (queryError) {
        setError(translateReadError(queryError));
        setPadron([]);
      } else {
        setError(null);
        setPadron(((data ?? []) as Omit<SocioListItem, 'es_invitado'>[]).map((s) => ({
          ...s,
          es_invitado: invSet.has(s.id),
        })));
      }
      setIsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // Filtrado local instantáneo (solo CPU, sin debounce ni race conditions).
  // Devuelve la lista COMPLETA (sin cortar): la página la pagina en la UI, así
  // recepción puede recorrer todos los socios por páginas, no solo los primeros.
  const socios = useMemo(() => {
    const term = query.trim();
    // Sin query → TODOS los de ESTA sede, alfabético (vista por defecto).
    if (!term) {
      return sucursalId ? padron.filter((s) => s.sucursal_id === sucursalId) : padron;
    }
    // Con query → busca en TODO el tenant (encuentra socios visitantes).
    const q = normalize(term);
    return padron.filter((s) => {
      if (normalize(s.nombre ?? '').includes(q)) return true;
      if (normalize(s.email ?? '').includes(q)) return true;
      // Teléfono sin normalizar (los números no tienen acentos).
      if ((s.telefono ?? '').includes(term)) return true;
      return false;
    });
  }, [padron, query, sucursalId]);

  return { socios, isLoading, error, refetch: () => setNonce((n) => n + 1) };
}
