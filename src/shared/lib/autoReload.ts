/**
 * Auto-recuperación ante una versión VIEJA cacheada.
 *
 * Aunque el SW use registerType:'autoUpdate' (recarga en 'controllerchange'),
 * hay dos casos donde el usuario queda pegado en la versión vieja ANTES de que
 * el SW alcance a actualizar:
 *   1. el index.html viejo pide un chunk JS que ya no existe → 404 al importar
 *      (Vite dispara 'vite:preloadError');
 *   2. la app vieja arranca pero rompe al leer datos → pantalla de error.
 *
 * En ambos casos limpiamos service worker + caches y hacemos UN hard reload,
 * UNA sola vez por sesión (flag en sessionStorage) para no caer en un loop si
 * la versión fresca también falla (ahí ya es un problema real → mostrar error).
 */

const FLAG = 'sala_auto_reload_v1';

/**
 * Limpia SW + caches y recarga, una sola vez por sesión.
 * @returns true si arrancó la recarga (mostrar "Actualizando…"), false si ya se
 *          intentó en esta sesión (dejar que se muestre el error real).
 */
export async function intentarAutoRecarga(): Promise<boolean> {
  try {
    if (sessionStorage.getItem(FLAG)) return false; // ya lo intentamos este ciclo
    sessionStorage.setItem(FLAG, '1');
  } catch {
    return false; // sin sessionStorage no arriesgamos un posible loop
  }

  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* aunque falle la limpieza, recargamos igual: el objetivo es traer lo fresco */
  }

  // reload(true) es no-estándar; el hard viene de haber borrado SW + caches.
  window.location.reload();
  return true;
}

/**
 * La app cargó bien → liberamos el flag para que una futura falla en la misma
 * sesión pueda auto-recuperarse de nuevo.
 */
export function limpiarFlagAutoRecarga(): void {
  try {
    sessionStorage.removeItem(FLAG);
  } catch {
    /* noop */
  }
}
