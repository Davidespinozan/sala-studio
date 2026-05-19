import { Link } from 'react-router-dom';
import { formatHora } from '@member/logic/reservaLogic';
import { estadoCupos, type Clase } from '@member/logic/claseAdapter';

interface Props {
  clase: Clase;
  /** Si está presente y la clase está llena/inaccesible, dim la card. */
  ya_reservada?: boolean;
}

/** Card pequeña para scroll horizontal en Home ("Clases de hoy"). */
export function ClaseCard({ clase, ya_reservada }: Props) {
  const esCancelada = clase.status === 'cancelada';
  const estado = estadoCupos(clase);
  const llena = estado === 'llena';
  const pocos = estado === 'pocos';

  return (
    <Link
      to={`/app/clase/${encodeURIComponent(clase.id)}`}
      aria-label={`${clase.nombre} ${formatHora(clase.slotInicio)}`}
      style={{
        flexShrink: 0,
        width: '180px',
        background: esCancelada ? 'var(--sala-bg)' : 'var(--sala-surface)',
        border: `1px solid ${pocos && !esCancelada ? 'var(--sala-accent-light)' : 'var(--sala-border)'}`,
        borderRadius: '16px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        textDecoration: 'none',
        color: 'var(--sala-text-primary)',
        opacity: esCancelada ? 0.6 : llena ? 0.55 : 1,
        boxShadow: '0 1px 3px rgba(26, 31, 28, 0.04)',
        transition: 'border-color 0.18s ease, transform 0.18s ease'
      }}
    >
      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '28px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          lineHeight: 1,
          margin: 0,
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {formatHora(clase.slotInicio)}
      </p>
      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '15px',
          fontWeight: 600,
          letterSpacing: '-0.02em',
          lineHeight: 1.2,
          margin: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {clase.disciplina}
      </p>
      <p
        style={{
          fontSize: '11px',
          color: 'var(--sala-text-tertiary)',
          margin: 0,
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase'
        }}
      >
        {clase.instructor}
      </p>
      <p
        style={{
          fontSize: '12px',
          fontWeight: 600,
          margin: 0,
          marginTop: 'auto',
          fontVariantNumeric: 'tabular-nums',
          color: esCancelada
            ? 'var(--sala-text-tertiary)'
            : llena
              ? 'var(--sala-text-tertiary)'
              : pocos
                ? 'var(--sala-accent)'
                : ya_reservada
                  ? 'var(--sala-primary)'
                  : 'var(--sala-text-secondary)'
        }}
      >
        {esCancelada
          ? 'Cancelada'
          : llena
            ? 'Llena'
            : ya_reservada
              ? 'Reservaste ✓'
              : pocos
                ? `¡${clase.cupoMax - clase.cuposReservados} lugares!`
                : `${clase.cuposReservados}/${clase.cupoMax} cupos`}
      </p>
    </Link>
  );
}
