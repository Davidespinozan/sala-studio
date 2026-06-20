import type { CSSProperties, ReactNode } from 'react';
import { ImageIcon } from 'lucide-react';

/**
 * Marcos de dispositivo para los screenshots del producto en la landing de
 * marketing. Si no hay imagen todavía, muestran un placeholder de marca que se
 * ve intencional (no roto) — así el layout queda listo y David dropea las
 * capturas en public/shots/ cuando las tenga.
 */

function Placeholder({ label }: { label: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '10px',
        background:
          'linear-gradient(135deg, color-mix(in srgb, var(--sala-primary) 14%, var(--sala-surface)), var(--sala-surface))',
        color: 'var(--sala-text-tertiary)'
      }}
    >
      <ImageIcon size={28} strokeWidth={1.75} aria-hidden="true" />
      <span style={{ fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em' }}>{label}</span>
    </div>
  );
}

// Sangra 2px por todos lados → mata cualquier sliver de fondo en las esquinas
// redondeadas (el "margen blanco" que se nota sobre oscuro). El recorte es
// imperceptible.
const BLEED: CSSProperties = {
  position: 'absolute',
  top: '-2px',
  left: '-2px',
  width: 'calc(100% + 4px)',
  height: 'calc(100% + 4px)',
  objectFit: 'cover',
  display: 'block'
};

/** Marco para capturas de escritorio (16:10). Sin barra de ventana — solo la
 *  captura/video en un marco redondeado, para que la imagen mande. Si se pasa
 *  `video`, reproduce un loop mudo (con `src` como poster); si no, la imagen. */
export function BrowserFrame({
  src,
  alt,
  video
}: {
  src?: string;
  alt: string;
  video?: { mp4?: string; webm?: string };
}) {
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '16 / 10',
        borderRadius: '14px',
        overflow: 'hidden',
        // Fondo OSCURO (no blanco): si quedara cualquier sub-píxel sin cubrir,
        // se funde con el fondo oscuro en vez de mostrar un margen blanco.
        background: '#0d1812',
        // Contorno claro (ring) + sombra ancha y difusa: la captura "flota".
        boxShadow:
          '0 0 0 1px rgba(255, 255, 255, 0.18), 0 50px 110px -12px rgba(0, 0, 0, 0.6), 0 18px 50px -20px rgba(0, 0, 0, 0.5)'
      }}
    >
      {video ? (
        <video
          poster={src}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-label={alt}
          style={BLEED}
        >
          {video.webm && <source src={video.webm} type="video/webm" />}
          {video.mp4 && <source src={video.mp4} type="video/mp4" />}
        </video>
      ) : src ? (
        <img src={src} alt={alt} style={BLEED} />
      ) : (
        <Placeholder label="Vista del producto" />
      )}
    </div>
  );
}

/** Marco de teléfono para capturas de la app del socio (9:19.5). Acepta `width`
 *  (para mostrar pares de teléfonos) y `video` (loop mudo con `src` de poster). */
export function PhoneFrame({
  src,
  alt,
  video,
  width = 'min(260px, 70vw)'
}: {
  src?: string;
  alt: string;
  video?: { mp4?: string; webm?: string };
  width?: string;
}) {
  return (
    <div
      style={{
        width,
        borderRadius: '34px',
        padding: '10px',
        background: 'var(--sala-neutral-dark, #1a1f1c)',
        // Ring claro: separa el teléfono oscuro del fondo verde oscuro.
        boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.14), 0 30px 70px rgba(10, 15, 12, 0.5)'
      }}
    >
      <div style={{ position: 'relative', borderRadius: '26px', overflow: 'hidden', aspectRatio: '9 / 19.5', background: '#0d1812' }}>
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            width: '38%',
            height: 18,
            borderRadius: '999px',
            background: 'var(--sala-neutral-dark, #1a1f1c)',
            zIndex: 2
          }}
        />
        {video ? (
          <video poster={src} autoPlay muted loop playsInline preload="metadata" aria-label={alt} style={BLEED}>
            {video.webm && <source src={video.webm} type="video/webm" />}
            {video.mp4 && <source src={video.mp4} type="video/mp4" />}
          </video>
        ) : src ? (
          <img src={src} alt={alt} style={BLEED} />
        ) : (
          <Placeholder label="App del socio" />
        )}
      </div>
    </div>
  );
}

/** Mockup de "tu marca como app instalable": ícono estilo iOS (squircle) con el
 *  monograma/ícono de la marca + el nombre, sobre un sutil fondo de pantalla de
 *  inicio. Muestra a un dueño cómo se vería su gym como app de iPhone. */
export function AppIconMockup({
  nombre,
  monograma,
  icon
}: {
  nombre: string;
  monograma: string;
  icon?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px' }}>
      <div
        style={{
          width: 'clamp(86px, 20vw, 112px)',
          aspectRatio: '1',
          borderRadius: '23%',
          background:
            'linear-gradient(158deg, color-mix(in srgb, var(--sala-primary) 50%, white), color-mix(in srgb, var(--sala-primary), black 6%))',
          boxShadow:
            '0 0 0 1px rgba(255,255,255,0.28), inset 0 1.5px 0 rgba(255,255,255,0.45), 0 24px 54px rgba(10,15,12,0.62)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#ffffff'
        }}
      >
        {icon ?? (
          <span style={{ fontFamily: 'var(--ek-font-display)', fontWeight: 800, fontSize: 'clamp(30px, 7vw, 40px)', letterSpacing: '-0.02em', color: '#fff' }}>
            {monograma}
          </span>
        )}
      </div>
      <span style={{ fontSize: '14px', fontWeight: 600, color: 'rgba(255,255,255,0.96)', letterSpacing: '-0.01em' }}>
        {nombre}
      </span>
    </div>
  );
}
