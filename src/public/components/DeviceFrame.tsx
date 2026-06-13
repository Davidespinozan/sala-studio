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

/** Marco de ventana de browser para capturas de escritorio (16:10). */
export function BrowserFrame({
  src,
  alt,
  url = 'tu-estudio.salastudio.app'
}: {
  src?: string;
  alt: string;
  url?: string;
}) {
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
          gap: '8px',
          padding: '10px 14px',
          borderBottom: '1px solid var(--sala-border)',
          background: 'var(--sala-bg)'
        }}
      >
        <span style={{ display: 'flex', gap: '6px' }}>
          {['#f0625a', '#f6be4f', '#5bcf66'].map((c) => (
            <span key={c} style={{ width: 10, height: 10, borderRadius: '50%', background: c, opacity: 0.85 }} />
          ))}
        </span>
        <span
          style={{
            flex: 1,
            textAlign: 'center',
            fontSize: '11px',
            color: 'var(--sala-text-tertiary)',
            background: 'var(--sala-surface)',
            border: '1px solid var(--sala-border)',
            borderRadius: '999px',
            padding: '3px 12px',
            maxWidth: '260px',
            margin: '0 auto',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {url}
        </span>
        <span style={{ width: 34 }} />
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
