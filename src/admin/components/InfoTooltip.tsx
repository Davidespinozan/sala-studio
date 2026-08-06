import { useState } from 'react';
import { Info } from 'lucide-react';

/**
 * Ícono ⓘ que abre un popover explicando qué mide una métrica / cálculo.
 * Click-toggle, con backdrop invisible para cerrar al tocar fuera (táctil).
 * Compartido por Reportes y el Dashboard para explicar cada número.
 */
export function InfoTooltip({ titulo, texto }: { titulo: string; texto: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', lineHeight: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Qué mide ${titulo}`}
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '32px',
          height: '32px',
          margin: '-7px', /* área de toque mayor sin empujar el layout */
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--sala-text-tertiary)',
          cursor: 'pointer'
        }}
      >
        <Info size={13} strokeWidth={2.25} />
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
            aria-hidden="true"
          />
          <div
            role="tooltip"
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              zIndex: 41,
              width: 'min(240px, 70vw)',
              padding: '10px 12px',
              background: 'var(--sala-surface)',
              border: '1px solid var(--sala-border)',
              borderRadius: '10px',
              boxShadow: 'var(--ek-shadow-modal, 0 12px 32px rgba(10,15,12,0.18))',
              fontSize: '12px',
              lineHeight: 1.5,
              fontWeight: 400,
              letterSpacing: 0,
              textTransform: 'none',
              color: 'var(--sala-text-secondary)',
              whiteSpace: 'normal'
            }}
          >
            {texto}
          </div>
        </>
      )}
    </span>
  );
}
