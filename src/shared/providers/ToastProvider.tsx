import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle, type LucideIcon } from 'lucide-react';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  durationMs: number;
}

interface ToastApi {
  success: (message: string, durationMs?: number) => void;
  error: (message: string, durationMs?: number) => void;
  warning: (message: string, durationMs?: number) => void;
  info: (message: string, durationMs?: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 3000,
  error: 5000,
  warning: 4000,
  info: 3000
};

const VARIANT_STYLES: Record<ToastVariant, { bg: string; border: string; color: string; Icon: LucideIcon }> = {
  success: {
    bg: 'var(--sala-success-bg)',
    border: 'var(--sala-success)',
    color: 'var(--sala-success)',
    Icon: CheckCircle2
  },
  error: {
    bg: 'var(--sala-error-bg)',
    border: 'var(--sala-error)',
    color: 'var(--sala-error)',
    Icon: XCircle
  },
  warning: {
    bg: 'var(--sala-warning-bg)',
    border: 'var(--sala-warning)',
    color: 'var(--sala-warning)',
    Icon: AlertTriangle
  },
  info: {
    bg: 'var(--sala-primary-light)',
    border: 'var(--sala-primary)',
    color: 'var(--sala-primary)',
    Icon: Info
  }
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const enqueue = useCallback(
    (variant: ToastVariant, message: string, durationMs?: number) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const duration = durationMs ?? DEFAULT_DURATION[variant];
      setToasts((prev) => [...prev, { id, message, variant, durationMs: duration }]);
      const timer = setTimeout(() => dismiss(id), duration);
      timersRef.current.set(id, timer);
    },
    [dismiss]
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (m, d) => enqueue('success', m, d),
      error: (m, d) => enqueue('error', m, d),
      warning: (m, d) => enqueue('warning', m, d),
      info: (m, d) => enqueue('info', m, d)
    }),
    [enqueue]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          left: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          zIndex: 200,
          maxWidth: '360px',
          pointerEvents: 'none'
        }}
      >
        {toasts.map((t) => {
          const style = VARIANT_STYLES[t.variant];
          const Icon = style.Icon;
          return (
            <div
              key={t.id}
              role="status"
              style={{
                pointerEvents: 'auto',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                padding: '12px 14px',
                background: style.bg,
                border: `0.5px solid ${style.border}`,
                borderRadius: 'var(--ek-r-md)',
                color: style.color,
                fontSize: '13px',
                lineHeight: 1.4,
                boxShadow: '0 8px 24px rgba(26, 31, 28, 0.12)',
                animation: 'ek-toast-slide 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
              }}
            >
              <Icon size={16} strokeWidth={2.25} style={{ flexShrink: 0, marginTop: '1px' }} />
              <span style={{ flex: 1, color: 'var(--ek-ink)' }}>{t.message}</span>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Cerrar"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--ek-ink-muted)',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: 0,
                  lineHeight: 1
                }}
              >
                <X size={15} strokeWidth={2.25} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast() llamado fuera de <ToastProvider>');
  }
  return ctx;
}
