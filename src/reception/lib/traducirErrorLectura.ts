// Traduce errores de LECTURA (Supabase / PostgREST / red) a español, para que
// las pantallas de recepción muestren un mensaje en vez de un empty silencioso.
// Defensivo: el error puede venir como objeto de Supabase ({ message, code }),
// como Error nativo, o como cualquier cosa.

interface SupabaseLikeError {
  message?: unknown;
  code?: unknown;
}

export function translateReadError(error: unknown): string {
  const e = (error ?? {}) as SupabaseLikeError;
  const code = typeof e.code === 'string' ? e.code : '';
  const message =
    typeof e.message === 'string' ? e.message : typeof error === 'string' ? error : '';
  const lower = message.toLowerCase();

  // Sin filas (PostgREST)
  if (code === 'PGRST116') return 'No encontramos ese dato';

  // RLS / permisos (Postgres 42501 = insufficient_privilege)
  if (
    code === '42501' ||
    lower.includes('row-level security') ||
    lower.includes('insufficient_privilege')
  ) {
    return 'Sin permiso para ver este dato';
  }

  // Red caída
  if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('network request failed')
  ) {
    return 'Sin conexión. Reintenta en unos segundos';
  }

  return 'No pudimos cargar la información. Reintenta en unos segundos';
}
