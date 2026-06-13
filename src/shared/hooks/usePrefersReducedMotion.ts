import { useEffect, useState } from 'react';

/**
 * `true` si el usuario pidió menos movimiento (prefers-reduced-motion: reduce).
 * El CSS ya apaga las animaciones globalmente; esto sirve para frenar la lógica
 * JS (auto-rotación de carruseles, etc.) que el CSS no puede tocar.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== 'undefined' && !!window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  return reduced;
}
