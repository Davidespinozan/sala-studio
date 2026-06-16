import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HeroView, SeccionPostHero, SeccionHeading } from '../../public/pages/Landing';
import { useTenant } from '@shared/hooks/useTenant';
import type {
  LandingHero,
  LandingPostHero,
  LandingSecciones
} from '@shared/hooks/useLandingConfig';

/**
 * Vista previa EN VIVO de la landing, reflejando el borrador que el admin edita.
 * Renderiza a un ancho de diseño fijo (desktop 1280 / móvil 390) y se escala con
 * transform:scale() para caber en el panel — fiel a fuentes/colores/estilos del
 * tenant (ya aplicados al :root). El contenido dinámico (salas, planes,
 * instructores) se representa con un placeholder, porque se edita en sus páginas.
 */
const DESIGN_DESKTOP = 1280;
const DESIGN_MOBILE = 390;

type Device = 'desktop' | 'mobile';

type CtaFinalDraft = { eyebrow: string; titulo: string; subtitulo: string; cta_texto: string };
type FooterDraft = { tagline: string; copyright: string; direccion: string; email: string };
type FaqDraft = { pregunta: string; respuesta: string }[];

export default function LandingPreview({
  hero,
  secciones,
  postHero,
  ctaFinal,
  faq,
  footer,
  mostrarInstructores,
  maxHeight = '52vh'
}: {
  hero: LandingHero;
  secciones: LandingSecciones;
  postHero: LandingPostHero;
  ctaFinal: CtaFinalDraft;
  faq: FaqDraft;
  footer: FooterDraft;
  mostrarInstructores: boolean;
  maxHeight?: string;
}) {
  const [device, setDevice] = useState<Device>('desktop');
  const DESIGN_W = device === 'mobile' ? DESIGN_MOBILE : DESIGN_DESKTOP;
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.32);
  const [innerH, setInnerH] = useState(420);

  // Escala = ancho disponible del panel / ancho de diseño. En móvil no se
  // sobre-escala (tope 1) y queda centrado a ~390px.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const raw = el.clientWidth / DESIGN_W;
      setScale(device === 'mobile' ? Math.min(1, raw) : raw);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [device, DESIGN_W]);

  // Altura del contenido renderizado → altura del wrapper (escalada).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const h = innerRef.current?.offsetHeight ?? 0;
    if (h && h !== innerH) setInnerH(h);
  });

  const renderedW = Math.round(DESIGN_W * scale);
  const renderedH = Math.round(innerH * scale);

  return (
    <div>
      {/* Toggle de dispositivo */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
        {(['desktop', 'mobile'] as Device[]).map((d) => {
          const active = device === d;
          return (
            <button
              key={d}
              type="button"
              onClick={() => setDevice(d)}
              style={{
                padding: '6px 14px',
                borderRadius: '999px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
                background: active ? 'var(--sala-primary)' : 'var(--sala-surface)',
                color: active ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)',
                border: `1px solid ${active ? 'var(--sala-primary)' : 'var(--sala-border)'}`
              }}
            >
              {d === 'desktop' ? 'Escritorio' : 'Móvil'}
            </button>
          );
        })}
      </div>

      <div
        ref={containerRef}
        style={{
          maxHeight,
          overflowY: 'auto',
          overflowX: 'hidden',
          borderRadius: '14px',
          border: '1px solid var(--sala-border)',
          background: 'var(--sala-bg)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: `${renderedW}px`, height: `${renderedH}px`, overflow: 'hidden' }}>
            <div
              ref={innerRef}
              style={{
                width: `${DESIGN_W}px`,
                transform: `scale(${scale})`,
                transformOrigin: 'top left'
              }}
            >
              <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '0 24px' }}>
                <HeroView hero={hero} preview forceMobile={device === 'mobile'} />
                <SeccionPostHero data={postHero} />

                <SeccionPreview heading={secciones.salas} placeholder="Tus salas (se editan en Salas)" />
                {mostrarInstructores && (
                  <SeccionPreview
                    heading={secciones.instructores}
                    placeholder="Tu equipo (se edita en Instructores)"
                  />
                )}
                <SeccionPreview heading={secciones.membresias} placeholder="Tus planes (se editan en Planes)" />

                <FaqPreview heading={secciones.faq} faq={faq} />
                <CtaPreview data={ctaFinal} />
                <FooterPreview data={footer} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Encabezado real + placeholder del contenido dinámico de la sección. */
function SeccionPreview({
  heading,
  placeholder
}: {
  heading: LandingSecciones['salas'];
  placeholder: string;
}) {
  return (
    <section style={{ padding: 'clamp(36px, 6vw, 64px) 0' }}>
      <SeccionHeading heading={heading} />
      <div
        style={{
          border: '1px dashed var(--sala-border)',
          borderRadius: '14px',
          padding: '32px',
          textAlign: 'center',
          color: 'var(--sala-text-tertiary)',
          fontSize: '14px'
        }}
      >
        {placeholder}
      </div>
    </section>
  );
}

function FaqPreview({
  heading,
  faq
}: {
  heading: LandingSecciones['faq'];
  faq: FaqDraft;
}) {
  const items = faq.filter((f) => f.pregunta.trim() || f.respuesta.trim());
  const sinHeading = !heading.eyebrow && !heading.titulo && !heading.titulo_accent && !heading.subtitulo;
  if (items.length === 0 && sinHeading) return null;
  return (
    <section style={{ padding: 'clamp(36px, 6vw, 64px) 0' }}>
      <SeccionHeading heading={heading} center={false} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {items.map((it, i) => (
          <div key={i} className="ek-card" style={{ padding: '20px 24px' }}>
            <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '18px', fontWeight: 600, margin: 0 }}>
              {it.pregunta || '—'}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function CtaPreview({ data }: { data: CtaFinalDraft }) {
  if (!data.eyebrow && !data.titulo && !data.subtitulo && !data.cta_texto) return null;
  return (
    <div
      style={{
        background: 'var(--grad-immersive)',
        borderRadius: 'var(--ek-r-card)',
        padding: 'clamp(40px, 6vw, 64px) 32px',
        textAlign: 'center',
        margin: '24px 0'
      }}
    >
      {data.eyebrow && (
        <p className="ek-eyebrow" style={{ marginBottom: '16px', color: 'var(--sala-warning)' }}>
          {data.eyebrow}
        </p>
      )}
      {data.titulo && (
        <h2
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(28px, 5vw, 44px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
            margin: 0,
            color: 'rgba(255, 255, 255, 0.97)'
          }}
        >
          {data.titulo}
        </h2>
      )}
      {data.subtitulo && (
        <p style={{ color: 'rgba(255, 255, 255, 0.7)', margin: '16px auto 0', maxWidth: '480px' }}>
          {data.subtitulo}
        </p>
      )}
      {data.cta_texto && (
        <span
          style={{
            display: 'inline-block',
            marginTop: '24px',
            padding: '14px 28px',
            borderRadius: '999px',
            background: '#fff',
            color: 'var(--sala-primary)',
            fontWeight: 600,
            fontSize: '15px'
          }}
        >
          {data.cta_texto}
        </span>
      )}
    </div>
  );
}

function FooterPreview({ data }: { data: FooterDraft }) {
  const tenant = useTenant();
  const contacto = [data.email, data.direccion].filter(Boolean).join(' · ');
  return (
    <div
      style={{
        borderTop: '1px solid var(--sala-border)',
        padding: '32px 0',
        marginTop: '24px',
        textAlign: 'center',
        color: 'var(--sala-text-tertiary)',
        fontSize: '13px'
      }}
    >
      {data.tagline && (
        <p className="ek-eyebrow" style={{ marginBottom: '8px' }}>
          {data.tagline}
        </p>
      )}
      {contacto && <p style={{ margin: '0 0 6px' }}>{contacto}</p>}
      <p style={{ margin: 0 }}>
        © {new Date().getFullYear()} {tenant.nombre || 'SALA Studio'}. {data.copyright}
      </p>
    </div>
  );
}
