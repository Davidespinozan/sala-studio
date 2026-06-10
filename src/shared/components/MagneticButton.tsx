import { useRef, useEffect, ReactNode, CSSProperties, MouseEvent } from 'react';

/**
 * CTA "magnético": el botón sigue sutilmente al cursor y vuelve suave al salir.
 * Renderiza un <a> (los CTAs del landing son links). Solo desktop (mousemove);
 * en táctil no se dispara y queda el botón normal. Respeta prefers-reduced-motion.
 *
 * Usa el easing premium (--ease-premium). Anima solo transform.
 */
export function MagneticButton({
  href,
  children,
  className = '',
  style,
  strength = 0.28,
  target,
  rel,
  onClick
}: {
  href: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Intensidad del seguimiento (0.2–0.3). Default 0.28. */
  strength?: number;
  target?: string;
  rel?: string;
  onClick?: () => void;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  }, []);

  const onMove = (e: MouseEvent<HTMLAnchorElement>) => {
    const el = ref.current;
    if (!el || reduced.current) return;
    const { left, top, width, height } = el.getBoundingClientRect();
    const x = (e.clientX - left - width / 2) * strength;
    const y = (e.clientY - top - height / 2) * strength;
    el.style.transform = `translate(${x}px, ${y}px)`;
  };

  const onLeave = () => {
    if (ref.current) ref.current.style.transform = 'translate(0, 0)';
  };

  return (
    <a
      ref={ref}
      href={href}
      target={target}
      rel={rel}
      onClick={onClick}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={className}
      style={{ transition: 'transform 0.35s var(--ease-premium)', ...style }}
    >
      {children}
    </a>
  );
}
