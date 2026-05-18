import { createClient } from '@supabase/supabase-js';
import type { Database } from '@shared/types/database';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn(
    '[supabase] VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY no definidas. ' +
    'Configura .env.local con las credenciales del proyecto.'
  );
}

/**
 * Cliente Supabase tipado.
 *
 * Tipos auto-generados desde el schema con `npm run supabase:types`.
 * Regenerar después de cada migración.
 *
 * Config crítica:
 * - persistSession: true → sesión sobrevive recarga
 * - autoRefreshToken: true → renovación automática del JWT
 * - detectSessionInUrl: true → magic links / OAuth callback
 * - storage: localStorage explícito → necesario para PWA en iOS Safari ITP
 *
 * IMPORTANTE: para evitar el deadlock de Supabase JS v2 dentro de
 * onAuthStateChange, NUNCA hagas `await supabase.from(...)` dentro del
 * callback. Difiérelo con setTimeout(() => { ... }, 0).
 * Ver docs/DECISIONS.md D-006.
 */
export const supabase = createClient<Database>(url ?? '', anonKey ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: typeof window !== 'undefined' ? window.localStorage : undefined
  }
});

export type SupabaseClient = typeof supabase;
