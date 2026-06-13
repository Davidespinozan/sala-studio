import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bell, Check, CheckCheck } from 'lucide-react';
import { useNotificaciones } from '@shared/hooks/useNotificaciones';

function tiempoRelativo(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `hace ${d} d`;
  return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}

/**
 * Campana de notificaciones reutilizable (socio / admin / recepción). Botón con
 * badge de no leídas + panel desplegable (posición fija anclada al botón, para
 * no recortarse contra headers con overflow). Marca como leída al tocar.
 */
export default function NotificacionesBell({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  const { items, noLeidas, isLoading, error, marcarLeida, marcarTodasLeidas } = useNotificaciones();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const iconColor = tone === 'dark' ? 'rgba(255,255,255,0.82)' : 'var(--ek-ink)';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notificaciones${noLeidas > 0 ? ` (${noLeidas} sin leer)` : ''}`}
        aria-expanded={open}
        className="ek-icon-btn"
        style={{
          position: 'relative',
          width: '40px',
          height: '40px',
          padding: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <Bell size={20} strokeWidth={2.25} style={{ color: iconColor }} />
        {noLeidas > 0 && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: '6px',
              right: '6px',
              minWidth: '16px',
              height: '16px',
              padding: '0 4px',
              borderRadius: '999px',
              background: 'var(--sala-error, #d4453b)',
              color: '#fff',
              fontSize: '10px',
              fontWeight: 800,
              lineHeight: '16px',
              textAlign: 'center'
            }}
          >
            {noLeidas > 9 ? '9+' : noLeidas}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notificaciones"
          style={{
            position: 'fixed',
            top: pos.top,
            right: pos.right,
            width: 'min(360px, calc(100vw - 16px))',
            maxHeight: 'min(480px, calc(100vh - 100px))',
            overflowY: 'auto',
            background: 'var(--ek-bg-soft)',
            border: '0.5px solid var(--ek-line)',
            borderRadius: 'var(--ek-r-card)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
            zIndex: 200,
            animation: 'ek-scale-in 0.16s cubic-bezier(0.16, 1, 0.3, 1)'
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '14px 16px',
              borderBottom: '0.5px solid var(--ek-line)',
              position: 'sticky',
              top: 0,
              background: 'var(--ek-bg-soft)'
            }}
          >
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ fontSize: '11px', margin: 0 }}>
              NOTIFICACIONES
            </p>
            {noLeidas > 0 && (
              <button
                type="button"
                onClick={() => void marcarTodasLeidas()}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '12px',
                  color: 'var(--ek-mustard)',
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                <CheckCheck size={14} strokeWidth={2.25} />
                Marcar todas
              </button>
            )}
          </div>

          {isLoading ? (
            <p style={{ padding: '24px 16px', fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, textAlign: 'center' }}>
              Cargando…
            </p>
          ) : error ? (
            <p style={{ padding: '24px 16px', fontSize: '13px', color: 'var(--sala-error)', margin: 0, textAlign: 'center' }}>
              {error}
            </p>
          ) : items.length === 0 ? (
            <p style={{ padding: '32px 16px', fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, textAlign: 'center' }}>
              No tenés notificaciones todavía.
            </p>
          ) : (
            <div>
              {items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => { if (!n.leida) void marcarLeida(n.id); }}
                  style={{
                    display: 'flex',
                    width: '100%',
                    textAlign: 'left',
                    gap: '10px',
                    padding: '12px 16px',
                    background: n.leida ? 'transparent' : 'var(--ek-mustard-soft)',
                    border: 'none',
                    borderBottom: '0.5px solid var(--ek-line)',
                    cursor: n.leida ? 'default' : 'pointer'
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      flexShrink: 0,
                      width: '8px',
                      height: '8px',
                      borderRadius: '999px',
                      marginTop: '5px',
                      background: n.leida ? 'transparent' : 'var(--ek-mustard)'
                    }}
                  />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: '13px',
                        fontWeight: 600,
                        color: 'var(--ek-ink)',
                        marginBottom: '2px'
                      }}
                    >
                      {n.titulo}
                    </span>
                    <span style={{ display: 'block', fontSize: '12px', color: 'var(--ek-ink-muted)', lineHeight: 1.45 }}>
                      {n.mensaje}
                    </span>
                    <span style={{ display: 'block', fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '4px' }}>
                      {tiempoRelativo(n.creada_at)}
                    </span>
                  </span>
                  {n.leida && (
                    <Check size={14} strokeWidth={2.25} style={{ flexShrink: 0, color: 'var(--ek-ink-faint)', marginTop: '3px' }} />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
