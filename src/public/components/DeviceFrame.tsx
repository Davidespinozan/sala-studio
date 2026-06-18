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

/** Marco de ventana (macOS) para capturas de escritorio (16:10). Sin barra de
 *  URL — solo el titlebar con los 3 puntos, para que la captura mande. */
export function BrowserFrame({ src, alt }: { src?: string; alt: string }) {
  return (
    <div
      style={{
        borderRadius: '14px',
        overflow: 'hidden',
        border: '1px solid var(--sala-border)',
        background: 'var(--sala-surface)',
        boxShadow: '0 30px 70px rgba(10, 15, 12, 0.28)'
      }}
    >
      <div
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '9px 14px',
          borderBottom: '1px solid var(--sala-border)',
          background: 'var(--sala-bg)'
        }}
      >
        {['#f0625a', '#f6be4f', '#5bcf66'].map((c) => (
          <span key={c} style={{ width: 10, height: 10, borderRadius: '50%', background: c, opacity: 0.85 }} />
        ))}
      </div>
      <div style={{ position: 'relative', aspectRatio: '16 / 10', background: 'var(--sala-surface)' }}>
        {src ? (
          <img src={src} alt={alt} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        ) : (
          <Placeholder label="Vista del producto" />
        )}
      </div>
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
        boxShadow: '0 30px 70px rgba(10, 15, 12, 0.34)'
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
