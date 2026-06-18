import type { CSSProperties } from 'react';
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

// Sangra 1px por todos lados → mata el sliver de fondo en las esquinas
// redondeadas (el "margen blanco"). El recorte es imperceptible.
const BLEED: CSSProperties = {
  position: 'absolute',
  top: '-1px',
  left: '-1px',
  width: 'calc(100% + 2px)',
  height: 'calc(100% + 2px)',
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
        background: 'var(--sala-surface)',
        // Contorno claro (ring) + sombra: hace resaltar la captura sobre el
        // verde oscuro del showcase, sin el "margen blanco" de un borde sólido.
        boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.18), 0 30px 70px rgba(10, 15, 12, 0.45)'
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

/** Marco de teléfono para capturas de la app del socio (9:19.5). */
export function PhoneFrame({ src, alt }: { src?: string; alt: string }) {
  return (
    <div
      style={{
        width: 'min(260px, 70vw)',
        borderRadius: '34px',
        padding: '10px',
        background: 'var(--sala-neutral-dark, #1a1f1c)',
        // Ring claro: separa el teléfono oscuro del fondo verde oscuro.
        boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.14), 0 30px 70px rgba(10, 15, 12, 0.5)'
      }}
    >
      <div style={{ position: 'relative', borderRadius: '26px', overflow: 'hidden', aspectRatio: '9 / 19.5', background: 'var(--sala-surface)' }}>
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
        {src ? (
          <img src={src} alt={alt} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        ) : (
          <Placeholder label="App del socio" />
        )}
      </div>
    </div>
  );
}
