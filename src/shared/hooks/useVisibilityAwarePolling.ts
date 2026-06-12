import { useEffect, useRef } from 'react';

/**
 * Polling que se pausa cuando la pestaña no está visible (ahorra batería/red en
 * iPads de mostrador con la pestaña en background) y se reanuda al volver.
 *
 * - Mientras `document.visibilityState === 'visible'`: setInterval(callback, intervalMs).
 * - Cuando pasa a hidden: clearInterval.
 * - Cuando vuelve de hidden → visible: dispara UN callback inmediato y reanuda el polling.
 *
 * El callback se guarda en un ref para que cambiar su identidad no reinicie el
 * intervalo (patrón useInterval): el polling siempre llama a la última versión.
 */
export function useVisibilityAwarePolling(callback: () => void, intervalMs: number): void {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(() => savedCallback.current(), intervalMs);
    };
    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        savedCallback.current(); // refetch inmediato al volver al foreground
        start();
      } else {
        stop();
      }
    };

    // Arranque según el estado actual (no dispara callback inmediato en montaje).
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [intervalMs]);
}
