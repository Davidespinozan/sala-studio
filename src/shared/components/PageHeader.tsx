import type { ReactNode } from 'react';

/**
 * Cabecera de página interna (admin + recepción). Dice DÓNDE estás (eyebrow +
 * título + subtítulo) y deja un slot a la derecha para CTAs/controles. No
 * duplica la identidad del shell (logo/rol/sesión) — eso vive en el AppSidebar.
 *
 * Mismo lenguaje que los headers de admin: eyebrow mustard + título display.
 */
interface Props {
  /** Contexto pequeño en mayúsculas (ej. "RECEPCIÓN", "RECEPCIÓN · FICHA"). */
  eyebrow?: string;
  /** Título principal (ej. "Hoy", "Socios", nombre del socio). */
  title: string;
  /** Línea secundaria opcional (ej. "Busca por nombre o teléfono"). */
  subtitle?: string;
  /** Slot a la derecha: CTAs o controles. En mobile baja debajo del título. */
  right?: ReactNode;
}

export function PageHeader({ eyebrow, title, subtitle, right }: Props) {
  return (
    <div
      style={{
        paddingBottom: '12px',
        marginBottom: '16px',
        borderBottom: '0.5px solid var(--sala-border)',
      }}
    >
      {eyebrow && (
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '6px' }}>
          {eyebrow}
        </p>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: '12px 16px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h1
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: 'clamp(26px, 4vw, 30px)',
              fontWeight: 700,
              letterSpacing: '-0.03em',
              lineHeight: 1.1,
              margin: 0,
            }}
          >
            {title}
          </h1>
          {subtitle && (
            <p
              style={{
                fontSize: '14px',
                fontWeight: 500,
                color: 'var(--sala-text-secondary)',
                margin: '6px 0 0',
              }}
            >
              {subtitle}
            </p>
          )}
        </div>
        {right && <div style={{ flexShrink: 0 }}>{right}</div>}
      </div>
    </div>
  );
}
