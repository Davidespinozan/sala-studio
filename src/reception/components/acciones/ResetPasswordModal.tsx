import { useEffect, useState } from 'react';
import { backendPost } from '@shared/lib/backend';

interface Props {
  socioId: string;
  socioNombre: string;
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

/**
 * Resetea la contraseña de un socio en el mostrador → genera una temporal para
 * entregarle. Modal autónomo (2 fases: confirmar → revelar la contraseña) para
 * poder mostrarla sin cerrar. Queda en la bitácora.
 */
export function ResetPasswordModal({ socioId, socioNombre, isOpen, onClose, onDone }: Props) {
  const [password, setPassword] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setPassword(null); setSubmitting(false); setError(null);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  async function resetear() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await backendPost<{ password: string }>('reception-reset-password', { usuario_id: socioId });
      setPassword(res.password);
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos resetear la contraseña.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={() => !submitting && onClose()}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(26, 31, 28, 0.55)',
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', zIndex: 110,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        animation: 'ek-fade-in 0.18s ease'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)', border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-card)', maxWidth: '440px', width: '100%', padding: '28px',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p className="ek-eyebrow" style={{ color: 'var(--ek-ink-muted)', marginBottom: '8px' }}>
          {password ? 'CONTRASEÑA TEMPORAL' : 'RESETEAR CONTRASEÑA'}
        </p>
        <h3 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '20px', fontWeight: 700, letterSpacing: '-0.02em', margin: '0 0 12px', color: 'var(--ek-ink)' }}>
          {password ? 'Pasale esta contraseña' : `Resetear la de ${socioNombre}`}
        </h3>

        {password ? (
          <>
            <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', lineHeight: 1.55, margin: '0 0 16px' }}>
              Entregásela al socio para que entre. Puede cambiarla después desde su perfil.
            </p>
            <div style={{ background: 'var(--sala-surface)', border: '0.5px solid var(--ek-line)', borderRadius: '12px', padding: '14px 16px', marginBottom: '18px' }}>
              <p style={{ fontSize: '18px', fontWeight: 600, color: 'var(--sala-text-primary)', margin: 0, fontFamily: 'var(--ek-font-mono)', letterSpacing: '0.02em' }}>
                {password}
              </p>
            </div>
            <button type="button" onClick={onClose} className="ek-cta" style={{ width: '100%' }}>Listo</button>
          </>
        ) : (
          <>
            <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', lineHeight: 1.55, margin: '0 0 16px' }}>
              Se genera una contraseña temporal nueva. La anterior deja de funcionar.
            </p>
            {error && (
              <p style={{ color: 'var(--ek-danger)', background: 'var(--ek-danger-soft)', border: '0.5px solid var(--sala-error-glow)', borderRadius: 'var(--ek-r-md)', padding: '10px 12px', fontSize: '0.875rem', margin: '0 0 16px' }}>
                {error}
              </p>
            )}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" onClick={() => !submitting && onClose()} disabled={submitting} className="ek-cta ek-cta--secondary" style={{ flex: 1 }}>
                Cancelar
              </button>
              <button type="button" onClick={resetear} disabled={submitting} className="ek-cta" style={{ flex: 1 }}>
                {submitting ? 'Reseteando…' : 'Resetear'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
