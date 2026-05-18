import { useState } from 'react';

export interface DropdownItem {
  label: string;
  icon: string;
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
 * Click fuera cierra. Selección cierra y ejecuta acción.
 * stopPropagation: el menú no propaga clicks al card padre.
 */
export default function CardMenuDropdown({ items }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="ek-icon-btn"
        aria-label="Acciones"
        aria-expanded={open}
        style={{ width: '32px', height: '32px', padding: 0, fontSize: '18px', lineHeight: 1 }}
      >
        ⋯
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
            aria-hidden="true"
          />
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              right: 0,
              minWidth: '220px',
              background: 'var(--ek-bg-soft)',
              border: '0.5px solid var(--ek-line)',
              borderRadius: '12px',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5)',
              padding: '6px',
              zIndex: 50,
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
                  <span aria-hidden="true">{item.icon}</span>
                  {item.label}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
