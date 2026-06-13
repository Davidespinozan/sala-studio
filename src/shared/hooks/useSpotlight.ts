import { useCallback } from 'react';

/**
 * Spotlight que sigue el cursor: devuelve un handler onMouseMove que escribe
 * las custom props --mx/--my en el elemento host. El glow real lo pinta un
 * `.sala-spotlight` hijo (CSS), visible solo en desktop con hover real.
 *
 * Uso:
 *   const onMouseMove = useSpotlight();
 *   <div className="sala-spotlight-host" onMouseMove={onMouseMove}>
 *     <div className="sala-spotlight" aria-hidden />
 *     …
 *   </div>
 */
export function useSpotlight() {
  return useCallback((e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, []);
}
