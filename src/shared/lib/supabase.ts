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
// ── Tenant activo (multi-gym) ───────────────────────────────────────────────
// El gym del subdominio actual. El TenantProvider lo setea al resolverlo, y viaja
// como header `x-tenant-id` en CADA petición. Hoy la base aún no lo usa (las
// funciones siguen en LIMIT 1), pero deja la tubería lista para que get_my_tenant_id
// pueda, más adelante, ubicar a una persona que esté en varios gyms — sin romper a
// quien tiene un solo gym (fallback). Ver plan multi-gym.
let activeTenantId: string | null = null;

/** Setea el gym activo que se mandará como header x-tenant-id. */
export function setActiveTenantId(id: string | null): void {
  activeTenantId = id;
}

/** fetch que adjunta x-tenant-id (si hay gym activo) a toda petición a Supabase. */
const fetchConTenant: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  if (activeTenantId) headers.set('x-tenant-id', activeTenantId);
  return fetch(input, { ...init, headers });
};

export const supabase = createClient<Database>(url ?? '', anonKey ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: typeof window !== 'undefined' ? window.localStorage : undefined
  },
  global: { fetch: fetchConTenant }
});

export type SupabaseClient = typeof supabase;
