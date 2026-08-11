import { lazy, type ComponentType } from 'react';
import { intentarAutoRecarga } from './autoReload';

/**
 * React.lazy con auto-recuperación de versión vieja.
 *
 * Tras un deploy, una pestaña abierta con el index.html viejo pide chunks que
 * ya no existen. El caso de los preloads lo cubre 'vite:preloadError' (main),
 * pero el import dinámico de React.lazy tiene su propio camino de falla y en
 * Safari se veía como "undefined is not an object (evaluating 'h._result.default')"
 * (E: SALA-STUDIO-2 en Sentry). Aquí lo atrapamos y recargamos UNA vez (mismo
 * flag de sesión que intentarAutoRecarga: sin loops); si la recarga ya se
 * intentó, el error sube al ErrorBoundary como siempre.
 */
export function lazyConRecarga<T extends ComponentType<unknown>>(
  importar: () => Promise<{ default: T }>
) {
  return lazy(async () => {
    try {
      return await importar();
    } catch (err) {
      const recargando = await intentarAutoRecarga();
      if (recargando) {
        // La página ya se está recargando: un componente vacío evita tronar
        // durante los milisegundos que tarda el reload.
        return { default: (() => null) as unknown as T };
      }
      throw err;
    }
  });
}
