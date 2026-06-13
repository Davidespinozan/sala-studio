// ============================================================================
// Modo "VER COMO…" del admin (Sprint D-Polish).
// ----------------------------------------------------------------------------
// El admin entra a una superficie previsualizada con ?demo=admin-preview, pero
// los navigate()/<Link> internos del app NO arrastran el query param → al
// segundo click se perdía y el admin se redirigía/ejectaba (useRoleRedirect) o
// perdía el banner con "Volver al admin".
//
// Solución: latch pegajoso por pestaña. La primera vez que se ve el param se
// persiste en sessionStorage; a partir de ahí el modo queda activo (aunque la
// URL ya no traiga el param) hasta que el admin sale ("Volver al admin").
// sessionStorage (no localStorage) = se limpia al cerrar la pestaña.
// ============================================================================

const KEY = 'sala-admin-preview';

function toParams(search: URLSearchParams | string): URLSearchParams {
  return typeof search === 'string' ? new URLSearchParams(search) : search;
}

/** true si el modo está activo: URL actual (?demo=admin-preview) o sticky. Puro. */
export function isAdminPreview(search: URLSearchParams | string): boolean {
  if (toParams(search).get('demo') === 'admin-preview') return true;
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Si la URL trae el flag, lo persiste para esta pestaña. Idempotente. */
export function latchAdminPreview(search: URLSearchParams | string): void {
  if (toParams(search).get('demo') !== 'admin-preview') return;
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    /* sessionStorage no disponible (modo privado estricto) — degradamos sin romper */
  }
}

/** Sale del modo preview (botón "Volver al admin"). */
export function exitAdminPreview(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
