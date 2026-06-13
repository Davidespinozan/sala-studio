import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@shared/hooks/usePrefersReducedMotion';
import type { LandingHeroSlide } from '@shared/hooks/useLandingConfig';

/**
 * Capa de fondo del hero: slides apilados con crossfade + Ken Burns en el
 * activo, puntitos (el activo se alarga en pill) y swipe en táctil. Auto-rota
 * cada `intervalMs` (se frena con prefers-reduced-motion). Un solo slide → sin
 * puntitos ni auto-rotación, solo Ken Burns.
 *
 * Cada slide trae su imagen desktop (16:9) y móvil (3:4, cae a desktop).
 */
export function HeroCarousel({
  slides,
  intervalMs = 5000
}: {
  slides: LandingHeroSlide[];
  intervalMs?: number;
}) {
  const reduced = usePrefersReducedMotion();
  const n = slides.length;
  const [idx, setIdx] = useState(0);
  const startX = useRef<number | null>(null);

  useEffect(() => {
    if (idx >= n) setIdx(0);
  }, [n, idx]);

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
      {slides.map((s, i) => (
        <picture key={`${i}-${s.desktop}`}>
          <source media="(max-width: 640px)" srcSet={s.mobile || s.desktop} />
          <img
            src={s.desktop}
            alt=""
            aria-hidden="true"
            className={`sala-hero-slide${i === idx ? ' is-active' : ''}`}
          />
        </picture>
      ))}

      {n > 1 && (
        <div className="sala-hero-dots">
          {slides.map((_, i) => (
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
