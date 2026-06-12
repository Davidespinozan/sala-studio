import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * Estado vacío compartido (admin + recepción). El ícono va en un círculo con
 * tinte sutil del primario del tenant — ese detalle es lo que lo eleva del
 * "plano" al lenguaje de admin. title + subtitle + acción opcional.
 */
interface Props {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, subtitle, action }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: '12px',
        padding: '48px 20px',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: '56px',
          height: '56px',
          borderRadius: '50%',
          background: 'var(--sala-primary-light)',
          color: 'var(--sala-primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon size={32} strokeWidth={1.5} />
      </div>

      <div>
        <p
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontWeight: 600,
            fontSize: '15px',
            color: 'var(--sala-text-secondary)',
            margin: 0,
          }}
        >
          {title}
        </p>
        {subtitle && (
          <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', margin: '4px 0 0' }}>
            {subtitle}
          </p>
        )}
      </div>

      {action && <div style={{ marginTop: '8px' }}>{action}</div>}
    </div>
  );
}
