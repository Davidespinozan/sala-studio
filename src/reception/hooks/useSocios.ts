import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

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

/**
 * Buscador de socios (read-only). Lista miembros del tenant filtrando por
 * nombre / teléfono / email. RLS ya scopea por tenant (usuarios_read_admin
 * acepta recepción). Debounced. Sin query → primeros 30 por nombre.
 */
export function useSocios(query: string) {
  const [socios, setSocios] = useState<SocioListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    // Sanitizar para no romper el filtro .or() de PostgREST (comas/paréntesis).
    const q = query.trim().replace(/[,()*]/g, ' ').trim();

    const timer = setTimeout(async () => {
      let req = supabase
        .from('usuarios')
        .select('id, nombre, email, telefono, avatar_url, membresia_tier, status')
        .eq('rol', 'miembro')
        .order('nombre', { ascending: true })
        .limit(30);

      if (q) {
        const like = `%${q}%`;
        req = req.or(`nombre.ilike.${like},telefono.ilike.${like},email.ilike.${like}`);
      }

      const { data, error } = await req;
      if (cancelled) return;
      if (error) {
        console.error('[useSocios]', error);
        setSocios([]);
      } else {
        setSocios((data ?? []) as SocioListItem[]);
      }
      setIsLoading(false);
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return { socios, isLoading };
}
