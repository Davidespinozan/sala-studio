import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@shared/hooks/usePrefersReducedMotion';

/**
 * Capa de fondo del hero: slides apilados con crossfade + Ken Burns en el
 * activo, puntitos (el activo se alarga en pill) y swipe en táctil. Auto-rota
 * cada `intervalMs` (se frena con prefers-reduced-motion). Una sola imagen →
 * sin puntitos ni auto-rotación, solo Ken Burns.
 *
 * Es decorativa (aria-hidden en las imágenes); los puntitos sí son
 * interactivos y etiquetados.
 */
export function HeroCarousel({
  imagenes,
  intervalMs = 5000
}: {
  imagenes: string[];
  intervalMs?: number;
}) {
  const reduced = usePrefersReducedMotion();
  const n = imagenes.length;
  const [idx, setIdx] = useState(0);
  const startX = useRef<number | null>(null);

  // Si cambia la cantidad de imágenes (preview en admin), no quedar fuera de rango.
  useEffect(() => {
    if (idx >= n) setIdx(0);
  }, [n, idx]);

  // Auto-rotación (pausada si hay <=1 imagen o el usuario pide menos movimiento).
  useEffect(() => {
    if (n <= 1 || reduced) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % n), intervalMs);
    return () => clearInterval(t);
  }, [n, reduced, intervalMs]);

  function onTouchStart(e: React.TouchEvent) {
    startX.current = e.touches[0]?.clientX ?? null;
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (startX.current == null || n <= 1) return;
    const dx = (e.changedTouches[0]?.clientX ?? startX.current) - startX.current;
    if (Math.abs(dx) > 40) setIdx((i) => (i + (dx < 0 ? 1 : -1) + n) % n);
    startX.current = null;
  }

  if (n === 0) return null;

  return (
    <div
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
    >
      {imagenes.map((src, i) => (
        <img
          key={`${i}-${src}`}
          src={src}
          alt=""
          aria-hidden="true"
          className={`sala-hero-slide${i === idx ? ' is-active' : ''}`}
        />
      ))}

      {n > 1 && (
        <div className="sala-hero-dots">
          {imagenes.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIdx(i)}
              aria-label={`Ver imagen ${i + 1} de ${n}`}
              aria-current={i === idx}
              className={`sala-hero-dot${i === idx ? ' is-active' : ''}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
