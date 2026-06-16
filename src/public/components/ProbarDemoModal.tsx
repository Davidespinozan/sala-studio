import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowRight } from 'lucide-react';
import { DEMO_VISTAS, entrarAlDemo, type DemoVista } from '@shared/lib/demoAuth';

/** Selector de vista del demo: admin / miembro / recepción → entra sin login. */
export default function ProbarDemoModal({ onClose }: { onClose: () => void }) {
  const [cargando, setCargando] = useState<DemoVista | null>(null);
  const [error, setError] = useState<string | null>(null);

  const entrar = async (rol: DemoVista) => {
    setError(null);
    setCargando(rol);
    const { error: err } = await entrarAlDemo(rol);
    if (err) {
      setError('No pudimos abrir el demo. Probá de nuevo en un momento.');
      setCargando(null);
    }
    // En éxito hay hard-nav, no vuelve.
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Probar demo"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(10, 15, 12, 0.55)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 'max(64px, 12vh) 16px 16px'
      }}
    >
      <div
        className="sala-brand"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '460px',
          background: 'var(--sala-surface)',
          borderRadius: '16px',
          boxShadow: '0 24px 60px rgba(10, 15, 12, 0.32)',
          overflow: 'hidden'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px 4px' }}>
          <div>
            <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '18px', fontWeight: 700, letterSpacing: '-0.02em', margin: 0, color: 'var(--sala-text-primary)' }}>
              Probá el demo
            </p>
            <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', margin: '2px 0 0' }}>
              Elegí una vista. Entrás al instante, sin registrarte.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            style={{ display: 'inline-flex', padding: '6px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--sala-text-tertiary)' }}
          >
            <X size={18} strokeWidth={2.25} />
          </button>
        </div>

        <div style={{ padding: '12px 16px 18px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {DEMO_VISTAS.map((v) => {
            const esta = cargando === v.rol;
            return (
              <button
                key={v.rol}
                type="button"
                disabled={cargando !== null}
                onClick={() => entrar(v.rol)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '14px 16px',
                  borderRadius: '12px',
                  border: '1px solid var(--sala-border)',
                  background: 'var(--sala-bg)',
                  cursor: cargando !== null ? 'default' : 'pointer',
                  textAlign: 'left',
                  fontFamily: 'inherit'
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: '15px', fontWeight: 700, color: 'var(--sala-text-primary)', margin: 0 }}>{v.label}</p>
                  <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '2px 0 0', lineHeight: 1.4 }}>{v.desc}</p>
                </div>
                <span style={{ flexShrink: 0, fontSize: '13px', fontWeight: 600, color: 'var(--sala-primary)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  {esta ? 'Entrando…' : <ArrowRight size={16} strokeWidth={2.5} />}
                </span>
              </button>
            );
          })}
          {error && <p style={{ fontSize: '12px', color: 'var(--sala-error)', margin: '2px 4px 0' }}>{error}</p>}
        </div>
      </div>
    </div>,
    document.body
  );
}
