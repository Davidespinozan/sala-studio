import { useEffect } from 'react';
import { Link } from 'react-router-dom';

export interface EstudioInfo {
  slug: string;
  nombre: string;
  tier: 'basica' | 'pro';
  capacidad: string;
  contenido: string[];
  descripcion: string;
  estiloVisual: string;
  equipoIncluido: string[];
  fotoUrl?: string;
  precioPro?: number;
  precioBasica?: number;
}

interface Props {
  estudio: EstudioInfo | null;
  onClose: () => void;
}

export default function EstudioModal({ estudio, onClose }: Props) {
  useEffect(() => {
    if (!estudio) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [estudio, onClose]);

  if (!estudio) return null;

  const esPro = estudio.tier === 'pro';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        animation: 'ek-fade-in 0.2s ease'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-card)',
          maxWidth: '640px',
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          position: 'relative',
          animation: 'ek-scale-in 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <button
          onClick={onClose}
          aria-label="Cerrar"
          style={{
            position: 'absolute',
            top: '16px',
            right: '16px',
            zIndex: 2,
            width: '36px',
            height: '36px',
            borderRadius: '50%',
            border: '0.5px solid var(--ek-line)',
            background: 'rgba(10, 10, 10, 0.7)',
            backdropFilter: 'blur(20px)',
            color: 'var(--ek-ink)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '18px',
            transition: 'all 0.18s ease'
          }}
        >
          ×
        </button>

        <div style={{
          background: 'linear-gradient(135deg, var(--ek-bg-elevated) 0%, var(--ek-bg) 100%)',
          aspectRatio: '16 / 9',
          position: 'relative',
          overflow: 'hidden',
          borderTopLeftRadius: 'var(--ek-r-card)',
          borderTopRightRadius: 'var(--ek-r-card)'
        }}>
          {estudio.fotoUrl ? (
            <img
              src={estudio.fotoUrl}
              alt={estudio.nombre}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block'
              }}
            />
          ) : (
            <div style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <span style={{
                fontSize: '11px',
                color: 'var(--ek-ink-faint)',
                letterSpacing: '0.2em',
                fontWeight: 600
              }}>FOTO PRÓXIMAMENTE</span>
            </div>
          )}

          <span
            className={esPro ? 'ek-badge ek-badge--outline' : 'ek-badge'}
            style={{ position: 'absolute', top: '16px', left: '16px' }}
          >
            {esPro ? '★ PRO' : 'BÁSICA'}
          </span>
        </div>

        <div style={{ padding: '32px' }}>
          <p className="ek-eyebrow" style={{ marginBottom: '8px' }}>ESTUDIO</p>
          <h2 style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(28px, 5vw, 40px)',
            fontWeight: 700,
            letterSpacing: '-0.04em',
            lineHeight: 1.05,
            margin: 0,
            marginBottom: '12px'
          }}>
            {estudio.nombre}
          </h2>

          <p className="ek-body" style={{
            color: 'var(--ek-ink-muted)',
            marginBottom: '24px',
            lineHeight: 1.5
          }}>
            {estudio.descripcion}
          </p>

          <div style={{ marginBottom: '24px' }}>
            <p className="ek-eyebrow" style={{ marginBottom: '10px' }}>IDEAL PARA</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {estudio.contenido.map(c => (
                <span key={c} className="ek-badge ek-badge--neutral">
                  {c}
                </span>
              ))}
            </div>
          </div>

          <div className="ek-stat-card" style={{ marginBottom: '20px' }}>
            <p className="ek-eyebrow" style={{ marginBottom: '4px' }}>CAPACIDAD</p>
            <p style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '24px',
              fontWeight: 700,
              margin: 0,
              letterSpacing: '-0.02em'
            }}>
              {estudio.capacidad}
            </p>
          </div>

          <div style={{ marginBottom: '20px' }}>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '12px' }}>
              EQUIPO INCLUIDO
            </p>
            <ul style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '8px'
            }}>
              {estudio.equipoIncluido.map(item => (
                <li
                  key={item}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '8px',
                    fontSize: '14px',
                    lineHeight: 1.5
                  }}
                >
                  <span style={{ color: 'var(--ek-mustard)', flexShrink: 0 }}>✓</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div style={{ marginBottom: '28px' }}>
            <p className="ek-eyebrow" style={{ marginBottom: '8px' }}>ESTILO</p>
            <p className="ek-body" style={{ lineHeight: 1.6, color: 'var(--ek-ink-muted)' }}>
              {estudio.estiloVisual}
            </p>
          </div>

          <Link
            to={`/signup?tier=${estudio.tier}`}
            className="ek-cta ek-cta--full"
            style={{ padding: '16px', fontSize: '15px', textAlign: 'center' }}
          >
            {esPro
              ? `Quiero la Pro${estudio.precioPro ? ` · $${estudio.precioPro.toLocaleString('es-MX')}/mes` : ''}`
              : `Empezar con Básica${estudio.precioBasica ? ` · $${estudio.precioBasica.toLocaleString('es-MX')}/mes` : ''}`}
          </Link>
        </div>
      </div>
    </div>
  );
}
