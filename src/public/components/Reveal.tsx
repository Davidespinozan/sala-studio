import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Scroll-reveal: el contenido aparece (sube + fade) cuando entra al viewport.
 * Usa la clase `.reveal`/`.reveal.visible` de sala.css (que ya respeta
 * prefers-reduced-motion: ahí queda visible sin animación). Una sola vez —
 * al revelarse, desconecta el observer.
 *
 * `delay` (1–3) escalona la entrada de elementos hermanos (stagger).
 */
export function Reveal({
  children,
  delay = 0,
  className = '',
  style
}: {
  children: ReactNode;
  delay?: 0 | 1 | 2 | 3;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Sin IntersectionObserver (entornos viejos/tests): mostrar directo.
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setVisible(true);
            obs.disconnect();
            break;
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const cls = ['reveal', visible ? 'visible' : '', delay ? `reveal-delay-${delay}` : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={ref} className={cls} style={style}>
      {children}
    </div>
  );
}
