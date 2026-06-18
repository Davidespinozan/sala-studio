import { useState, useRef, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

export interface DropdownItem {
  label: string;
  /** Ícono del item. Lucide-react component (preferido) o string Unicode. */
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Renderiza un separador horizontal antes de este item. */
  divider?: boolean;
}

interface Props {
  items: DropdownItem[];
}

/**
 * Menú "⋯" reusable para cards de admin (Recursos, Tiers, Equipo).
 * El menú se renderiza en un PORTAL a document.body con posición fija calculada
 * desde el botón: así no lo recorta ni lo tapa la card de abajo (antes, al ser
 * `absolute` dentro de la card, la siguiente card lo cubría). Click fuera cierra.
 */
export default function CardMenuDropdown({ items }: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    }
  }, [open]);

  return (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="ek-icon-btn"
        aria-label="Acciones"
        aria-expanded={open}
        style={{ width: '32px', height: '32px', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}
      >
        <MoreHorizontal size={18} strokeWidth={2.25} />
      </button>
      {open && pos &&
        createPortal(
          <>
            <div
              onClick={() => setOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 1000 }}
              aria-hidden="true"
            />
            <div
              style={{
                position: 'fixed',
                top: pos.top,
                right: pos.right,
                minWidth: '220px',
                background: 'var(--sala-surface)',
                border: '0.5px solid var(--ek-line)',
                borderRadius: '12px',
                boxShadow: '0 12px 32px rgba(26, 31, 28, 0.16)',
                padding: '6px',
                zIndex: 1001,
                animation: 'ek-fade-in 0.12s ease'
              }}
              role="menu"
            >
              {items.map((item, idx) => (
                <div key={`${item.label}-${idx}`}>
                  {item.divider && (
                    <div style={{ height: '0.5px', background: 'var(--ek-line)', margin: '4px 0' }} />
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      if (!item.disabled) item.onClick();
                    }}
                    disabled={item.disabled}
                    role="menuitem"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      width: '100%',
                      padding: '8px 12px',
                      background: 'transparent',
                      border: 'none',
                      borderRadius: '8px',
                      color: item.danger ? 'var(--ek-danger)' : 'var(--ek-ink)',
                      fontSize: '13px',
                      fontFamily: 'inherit',
                      textAlign: 'left',
                      cursor: item.disabled ? 'not-allowed' : 'pointer',
                      opacity: item.disabled ? 0.5 : 1
                    }}
                    onMouseEnter={(e) => {
                      if (!item.disabled) e.currentTarget.style.background = 'var(--ek-bg-elevated)';
                    }}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span
                      aria-hidden="true"
                      style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
                    >
                      {item.icon}
                    </span>
                    {item.label}
                  </button>
                </div>
              ))}
            </div>
          </>,
          document.body
        )}
    </div>
  );
}
