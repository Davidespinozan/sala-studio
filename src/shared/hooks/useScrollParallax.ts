import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from '@shared/hooks/usePrefersReducedMotion';

/**
 * Parallax al scroll: traslada el elemento a una fracción de la velocidad del
 * scroll (sensación de profundidad). Listener passive + rAF-throttled, y se
 * apaga con prefers-reduced-motion. Devuelve un ref para el elemento a mover
 * (idealmente sobredimensionado/overflow-hidden para no mostrar bordes).
 */
export function useScrollParallax<T extends HTMLElement>(factor = 0.15) {
  const ref = useRef<T>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced || typeof window === 'undefined') return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      if (ref.current) ref.current.style.transform = `translate3d(0, ${window.scrollY * factor}px, 0)`;
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(apply);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    apply();
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [reduced, factor]);

  return ref;
}
