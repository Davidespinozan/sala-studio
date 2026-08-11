import type { Database } from '@shared/types/database';
import { Avatar } from '@shared/components/Avatar';

type Usuario = Database['public']['Tables']['usuarios']['Row'];

interface Props {
  miembro: Usuario;
  planNombre: string | null;
  diasParaVencimiento: number | null;
  /** Saldo de créditos (solo planes por créditos/híbrido). null = no aplica. */
  creditosRestantes: number | null;
  estaBloqueado: boolean;
  onCambiarPlan: () => void;
  onBloquearAcceso: () => void;
  onEditarDatos: () => void;
}

function capitalizar(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}


// El status de `usuarios` es de la CUENTA (login/app/historial), no del plan —
// un day pass vencido NO apaga la cuenta. El label lo dice explícito para que
// no se lea como "miembro con plan vigente" junto a un chip de plan vencido.
const STATUS_LABEL: Record<string, { label: string; color: string; bg: string }> = {
  activo: {
    label: 'Cuenta activa',
    color: 'var(--sala-success)',
    bg: 'var(--sala-success-bg)'
  },
  suspendido: {
    label: 'Suspendido',
    color: 'var(--sala-warning)',
    bg: 'var(--sala-warning-bg)'
  },
  cancelado: {
    label: 'Cancelado',
    color: 'var(--sala-text-tertiary)',
    bg: 'var(--sala-bg)'
  },
  pendiente_onboarding: {
    label: 'Pendiente onboarding',
    color: 'var(--sala-warning)',
    bg: 'var(--sala-warning-bg)'
  },
  pendiente_pago: {
    label: 'Pendiente pago',
    color: 'var(--sala-warning)',
    bg: 'var(--sala-warning-bg)'
  }
};

export function MiembroHero({
  miembro,
  planNombre,
  diasParaVencimiento,
  creditosRestantes,
  estaBloqueado,
  onCambiarPlan,
  onBloquearAcceso,
  onEditarDatos
}: Props) {
  const nombreFmt = capitalizar(miembro.nombre);
  const statusCfg = STATUS_LABEL[miembro.status] ?? {
    label: miembro.status,
    color: 'var(--sala-text-tertiary)',
    bg: 'var(--sala-bg)'
  };

  const bloqueadoBadge = estaBloqueado
    ? {
        label: 'Bloqueado',
        color: 'var(--sala-accent)',
        bg: 'var(--sala-accent-light)'
      }
    : null;

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, var(--sala-surface) 0%, var(--sala-primary-light) 100%)',
        border: '1px solid var(--sala-border)',
        borderRadius: '20px',
        padding: '24px',
        marginBottom: '24px',
        boxShadow: '0 2px 12px rgba(26, 31, 28, 0.04)',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px'
      }}
    >
      {/* Top: avatar + identidad */}
      <div
        style={{
          display: 'flex',
          gap: '16px',
          alignItems: 'center',
          flexWrap: 'wrap'
        }}
      >
        <Avatar
          src={miembro.avatar_url}
          nombre={miembro.nombre}
          email={miembro.email}
          size={64}
          fallbackBg="var(--sala-primary)"
          fallbackColor="var(--sala-text-on-primary)"
          style={{ border: '1px solid var(--sala-border-strong)' }}
        />

        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--sala-primary)',
              margin: 0,
              marginBottom: '4px'
            }}
          >
            Miembro
          </p>
          <h1
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: 'clamp(24px, 5vw, 32px)',
              fontWeight: 600,
              letterSpacing: '-0.03em',
              lineHeight: 1.1,
              color: 'var(--sala-text-primary)',
              margin: 0,
              marginBottom: '6px'
            }}
          >
            {nombreFmt || miembro.email}
          </h1>
          <p
            style={{
              fontSize: '13px',
              color: 'var(--sala-text-secondary)',
              margin: 0,
              wordBreak: 'break-word'
            }}
          >
            {miembro.email}
            {miembro.telefono && ` · ${miembro.telefono}`}
          </p>
        </div>
      </div>

      {/* Badges */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
        {planNombre ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
              padding: '8px 14px',
              background: 'var(--sala-primary)',
              color: 'var(--sala-text-on-primary)',
              borderRadius: '12px'
            }}
          >
            <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', opacity: 0.85 }}>
              Plan
            </span>
            <span style={{ fontSize: '14px', fontWeight: 600, lineHeight: 1.2 }}>
              {planNombre}
            </span>
            {diasParaVencimiento !== null && (
              <span style={{ fontSize: '11px', opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>
                {diasParaVencimiento > 0
                  ? `Vence en ${diasParaVencimiento} ${diasParaVencimiento === 1 ? 'día' : 'días'}`
                  : diasParaVencimiento === 0
                    ? 'Vence hoy'
                    : `Vencido hace ${Math.abs(diasParaVencimiento)} ${Math.abs(diasParaVencimiento) === 1 ? 'día' : 'días'}`}
              </span>
            )}
            {creditosRestantes !== null && (
              <span style={{ fontSize: '11px', opacity: 0.95, fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                {creditosRestantes} {creditosRestantes === 1 ? 'clase restante' : 'clases restantes'}
              </span>
            )}
          </div>
        ) : (
          <div
            style={{
              padding: '8px 14px',
              background: 'var(--sala-bg)',
              color: 'var(--sala-text-secondary)',
              border: '1px dashed var(--sala-border-strong)',
              borderRadius: '12px',
              fontSize: '13px',
              fontWeight: 500
            }}
          >
            Sin plan activo
          </div>
        )}

        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: statusCfg.color,
            background: statusCfg.bg,
            padding: '8px 14px',
            borderRadius: '999px'
          }}
        >
          {statusCfg.label}
        </span>

        {bloqueadoBadge && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: bloqueadoBadge.color,
              background: bloqueadoBadge.bg,
              padding: '8px 14px',
              borderRadius: '999px'
            }}
          >
            {bloqueadoBadge.label}
          </span>
        )}
      </div>

      {/* Acciones rápidas */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '10px'
        }}
      >
        <button
          type="button"
          onClick={onCambiarPlan}
          className="ek-cta"
          style={{ padding: '10px 18px', minHeight: '40px', fontSize: '13px' }}
        >
          Cambiar plan
        </button>
        <button
          type="button"
          onClick={onEditarDatos}
          className="ek-cta ek-cta--secondary"
          style={{ padding: '10px 18px', minHeight: '40px', fontSize: '13px' }}
        >
          Editar datos
        </button>
        <button
          type="button"
          onClick={onBloquearAcceso}
          className="ek-cta ek-cta--secondary"
          style={{ padding: '10px 18px', minHeight: '40px', fontSize: '13px' }}
        >
          {estaBloqueado ? 'Desbloquear' : 'Bloquear acceso'}
        </button>
      </div>
    </div>
  );
}
