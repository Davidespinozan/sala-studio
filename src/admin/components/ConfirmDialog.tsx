import { useEffect, useState } from 'react';

type Variant = 'danger' | 'warning' | 'info';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  variant?: Variant;
  /** Si true, oculta el botón confirmar (modo "informativo bloqueante"). */
  hideConfirm?: boolean;
  /** Si se setea, el botón confirmar queda disabled hasta que el usuario tipee exactamente esta palabra. */
  requireTypedConfirmation?: string;
}

const VARIANT_STYLES: Record<Variant, { borderColor: string; eyebrowColor: string }> = {
  danger: {
    borderColor: 'var(--ek-danger)',
    eyebrowColor: 'var(--ek-danger)'
  },
  warning: {
    borderColor: 'var(--ek-mustard-dim)',
    eyebrowColor: 'var(--ek-mustard)'
  },
  info: {
    borderColor: 'var(--ek-line)',
    eyebrowColor: 'var(--ek-ink-muted)'
  }
};

const VARIANT_EYEBROW_LABEL: Record<Variant, string> = {
  danger: 'ACCIÓN BLOQUEADA',
  warning: 'CONFIRMAR ACCIÓN',
  info: 'INFORMACIÓN'
};

export default function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  onConfirm,
  onCancel,
  variant = 'warning',
  hideConfirm = false,
  requireTypedConfirmation
}: ConfirmDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setTyped('');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onCancel();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [isOpen, onCancel, submitting]);

  if (!isOpen) return null;

  const typedOk = !requireTypedConfirmation || typed === requireTypedConfirmation;
  const confirmDisabled = submitting || !typedOk;

  const style = VARIANT_STYLES[variant];

  async function handleConfirm() {
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={() => !submitting && onCancel()}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        zIndex: 110,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        animation: 'ek-fade-in 0.18s ease'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)',
          border: `0.5px solid ${style.borderColor}`,
          borderRadius: 'var(--ek-r-card)',
          maxWidth: '480px',
          width: '100%',
          padding: '28px',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p
          className="ek-eyebrow"
          style={{ color: style.eyebrowColor, marginBottom: '8px' }}
        >
          {VARIANT_EYEBROW_LABEL[variant]}
        </p>
        <h3
          id="confirm-dialog-title"
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            margin: 0,
            marginBottom: '12px',
            color: 'var(--ek-ink)'
          }}
        >
          {title}
        </h3>
        <p
          style={{
            fontSize: '13px',
            color: 'var(--ek-ink-muted)',
            lineHeight: 1.55,
            margin: 0,
            marginBottom: requireTypedConfirmation ? '16px' : '24px'
          }}
        >
          {description}
        </p>

        {requireTypedConfirmation && !hideConfirm && (
          <div style={{ marginBottom: '20px' }}>
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', marginBottom: '6px' }}>
              Escribí <strong style={{ color: 'var(--ek-ink)' }}>{requireTypedConfirmation}</strong> para confirmar:
            </p>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="ek-input"
              autoFocus
              placeholder={requireTypedConfirmation}
              style={{ fontFamily: 'var(--ek-font-mono)' }}
            />
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={() => !submitting && onCancel()}
            disabled={submitting}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            {cancelLabel}
          </button>
          {!hideConfirm && (
            <button
              type="button"
              onClick={handleConfirm}
              disabled={confirmDisabled}
              className="ek-cta"
              style={{
                flex: 1,
                opacity: confirmDisabled && !submitting ? 0.4 : 1,
                ...(variant === 'danger' && {
                  background: 'var(--ek-danger-soft)',
                  color: 'var(--ek-danger)',
                  border: '0.5px solid var(--ek-danger)'
                })
              }}
            >
              {submitting ? 'Procesando…' : confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
