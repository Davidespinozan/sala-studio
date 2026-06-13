import { useEffect, useRef, useState, type ReactNode } from 'react';

type Variant = 'danger' | 'warning' | 'info';

/** Elementos enfocables visibles dentro de un contenedor (para el focus-trap). */
function focusablesDe(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null);
}

interface Props {
  isOpen: boolean;
  title: string;
  description?: string;
  variant?: Variant;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Si se setea, el botón Confirmar queda disabled hasta que el usuario tipee exactamente esta palabra. */
  requireTypedConfirmation?: string;
  /** Gate extra (ej. motivo no vacío). Default true. */
  canConfirm?: boolean;
  /** Slot de campos (ej. <MotivoField/>). */
  children?: ReactNode;
  /** Ejecuta la acción. Si lanza, el modal muestra error.message inline (no traduce). */
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

const VARIANT_STYLES: Record<Variant, { borderColor: string; eyebrowColor: string }> = {
  danger: { borderColor: 'var(--ek-danger)', eyebrowColor: 'var(--ek-danger)' },
  warning: { borderColor: 'var(--ek-mustard-dim)', eyebrowColor: 'var(--ek-mustard)' },
  info: { borderColor: 'var(--ek-line)', eyebrowColor: 'var(--ek-ink-muted)' },
};

const VARIANT_EYEBROW: Record<Variant, string> = {
  danger: 'ACCIÓN SENSIBLE',
  warning: 'CONFIRMAR ACCIÓN',
  info: 'ACCIÓN',
};

/**
 * Modal base reutilizable para cualquier acción de mostrador. Hereda la estética
 * del ConfirmDialog de admin (backdrop blur + scale-in + Escape + scroll-lock) y
 * agrega un slot `children` para campos (ej. MotivoField) + manejo de error inline.
 *
 * Es AGNÓSTICO de códigos de error: muestra tal cual el error.message que lance
 * onConfirm. El caller traduce antes de lanzar (ej. con translateActionError).
 */
export function AccionModal({
  isOpen,
  title,
  description,
  variant = 'warning',
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  requireTypedConfirmation,
  canConfirm = true,
  children,
  onConfirm,
  onClose,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  // Apertura: reset, foco inicial dentro del modal, scroll-lock; al cerrar
  // restaura el foco al elemento que abrió el modal (a11y).
  useEffect(() => {
    if (!isOpen) return;
    setTyped('');
    setError(null);
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) (focusablesDe(panel)[0] ?? panel).focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      prevFocusRef.current?.focus?.();
    };
  }, [isOpen]);

  // Teclado: Escape cierra; Tab queda atrapado dentro del modal.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) { onClose(); return; }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const f = focusablesDe(panel);
      if (f.length === 0) { e.preventDefault(); return; }
      const first = f[0];
      const last = f[f.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, submitting]);

  if (!isOpen) return null;

  const typedOk = !requireTypedConfirmation || typed === requireTypedConfirmation;
  const confirmDisabled = submitting || !canConfirm || !typedOk;
  const style = VARIANT_STYLES[variant];

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error inesperado');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="accion-modal-title"
      onClick={() => !submitting && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(26, 31, 28, 0.55)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        zIndex: 110,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        animation: 'ek-fade-in 0.18s ease',
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)',
          border: `0.5px solid ${style.borderColor}`,
          borderRadius: 'var(--ek-r-card)',
          maxWidth: '480px',
          width: '100%',
          padding: '28px',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
          outline: 'none',
        }}
      >
        <p className="ek-eyebrow" style={{ color: style.eyebrowColor, marginBottom: '8px' }}>
          {VARIANT_EYEBROW[variant]}
        </p>
        <h3
          id="accion-modal-title"
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            margin: 0,
            marginBottom: description ? '12px' : '16px',
            color: 'var(--ek-ink)',
          }}
        >
          {title}
        </h3>

        {description && (
          <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', lineHeight: 1.55, margin: '0 0 16px' }}>
            {description}
          </p>
        )}

        {children && <div style={{ marginBottom: '16px' }}>{children}</div>}

        {requireTypedConfirmation && (
          <div style={{ marginBottom: '16px' }}>
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', marginBottom: '6px' }}>
              Escribí <strong style={{ color: 'var(--ek-ink)' }}>{requireTypedConfirmation}</strong> para confirmar:
            </p>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="ek-input"
              placeholder={requireTypedConfirmation}
              style={{ fontFamily: 'var(--ek-font-mono)' }}
            />
          </div>
        )}

        {error && (
          <p
            style={{
              color: 'var(--ek-danger)',
              background: 'var(--ek-danger-soft)',
              border: '0.5px solid var(--sala-error-glow)',
              borderRadius: 'var(--ek-r-md)',
              padding: '10px 12px',
              fontSize: '0.875rem',
              margin: '0 0 16px',
            }}
          >
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            {cancelLabel}
          </button>
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
                border: '0.5px solid var(--ek-danger)',
              }),
            }}
          >
            {submitting ? 'Procesando…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
