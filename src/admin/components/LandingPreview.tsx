import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HeroView, SeccionPostHero } from '../../public/pages/Landing';
import type { LandingHero, LandingPostHero } from '@shared/hooks/useLandingConfig';

/**
 * Vista previa EN VIVO del hero + sección post-hero de la landing, reflejando el
 * borrador que el admin edita. Técnica: se renderiza a un ancho de diseño fijo
 * (como se vería en desktop) y se escala con transform:scale() para caber en el
 * panel — así el resultado es fiel (mismas fuentes/colores/estilos del tenant,
 * que ya están aplicados al :root) sin duplicar el markup de la landing.
 */
const DESIGN_W = 1280;

export default function LandingPreview({
  hero,
  postHero
}: {
  hero: LandingHero;
  postHero: LandingPostHero;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.32);
  const [innerH, setInnerH] = useState(420);

  // Escala = ancho disponible del panel / ancho de diseño.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth / DESIGN_W);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Altura del contenido renderizado → altura del wrapper (escalada). Sin deps
  // a propósito (re-mide en cada render por cambios del draft); la guarda evita
  // el loop de updates al no setear si el valor no cambió.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const h = innerRef.current?.offsetHeight ?? 0;
    if (h && h !== innerH) setInnerH(h);
  });

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        overflow: 'hidden',
        borderRadius: '14px',
        border: '1px solid var(--sala-border)',
        background: 'var(--sala-bg)'
      }}
    >
      <div style={{ height: `${Math.round(innerH * scale)}px` }}>
        <div
          ref={innerRef}
          style={{
            width: `${DESIGN_W}px`,
            transform: `scale(${scale})`,
            transformOrigin: 'top left'
          }}
        >
          <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '0 24px' }}>
            <HeroView hero={hero} preview />
            <SeccionPostHero data={postHero} />
          </div>
        </div>
      </div>
    </div>
  );
}
