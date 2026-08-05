import { estadoCupos, type Clase } from '@member/logic/claseAdapter';

interface Props {
  clase: Clase;
  onClick: () => void;
}

/** Celda compacta para la grilla semanal admin. */
export function ClaseCellAdmin({ clase, onClick }: Props) {
  const esCancelada = clase.status === 'cancelada';
  const estado = estadoCupos(clase);
  const llena = estado === 'llena';
  const pocos = estado === 'pocos';

  // Clase cancelada: celda apagada, tachada, sigue clickeable para ver inscritos.
  if (esCancelada) {
    return (
      <button
        type="button"
        onClick={onClick}
        style={{
          width: '100%',
          background: 'var(--sala-bg)',
          border: '1px solid var(--sala-border)',
          borderLeft: '3px solid var(--sala-text-tertiary)',
          borderRadius: '8px',
          padding: '6px 8px',
          textAlign: 'left',
          cursor: 'pointer',
          fontFamily: 'inherit',
          display: 'block',
          minWidth: 0
        }}
      >
        <span
          style={{
            fontSize: '9px',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--sala-text-tertiary)',
            display: 'block',
            marginBottom: '2px'
          }}
        >
          Cancelada
        </span>
        <span
          style={{
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--sala-text-tertiary)',
            fontVariantNumeric: 'tabular-nums',
            fontFamily: 'var(--ek-font-display)',
            display: 'block',
            textDecoration: 'line-through',
            opacity: 0.6
          }}
        >
          {clase.horaLabel}
        </span>
      </button>
    );
  }

  const borderLeftColor = llena
    ? 'var(--sala-text-tertiary)'
    : pocos
      ? 'var(--sala-accent)'
      : 'var(--sala-primary)';
  const borderColor = pocos ? 'var(--sala-accent)' : 'var(--sala-border)';
  const cupoColor = llena
    ? 'var(--sala-text-tertiary)'
    : pocos
      ? 'var(--sala-accent)'
      : 'var(--sala-text-secondary)';

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        background: 'var(--sala-surface)',
        border: `1px solid ${borderColor}`,
        borderLeft: `3px solid ${borderLeftColor}`,
        borderRadius: '8px',
        padding: '6px 8px',
        textAlign: 'left',
        cursor: 'pointer',
        opacity: llena ? 0.75 : 1,
        fontFamily: 'inherit',
        boxShadow: '0 1px 2px rgba(26, 31, 28, 0.04)',
        transition: 'transform 0.12s ease, box-shadow 0.18s ease',
        display: 'block',
        minWidth: 0
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = '0 4px 8px rgba(26, 31, 28, 0.10)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = '0 1px 2px rgba(26, 31, 28, 0.04)';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      <span
        style={{
          fontSize: '9px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--sala-primary)',
          display: 'block',
          marginBottom: '2px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {clase.nombre}
      </span>
      <span
        style={{
          fontSize: '11px',
          fontWeight: 600,
          color: 'var(--sala-text-primary)',
          fontVariantNumeric: 'tabular-nums',
          fontFamily: 'var(--ek-font-display)',
          display: 'block',
          marginBottom: '2px',
          letterSpacing: '-0.01em'
        }}
      >
        {clase.horaLabel}
      </span>
      <span
        style={{
          fontSize: '10px',
          fontVariantNumeric: 'tabular-nums',
          color: cupoColor,
          fontWeight: pocos || llena ? 600 : 500,
          display: 'block'
        }}
      >
        {llena
          ? 'Llena'
          : pocos
            ? `¡${clase.cupoMax - clase.cuposReservados} libres!`
            : `${clase.cuposReservados}/${clase.cupoMax}`}
      </span>
    </button>
  );
}
