import { useNavigate } from 'react-router-dom';
import { formatHora } from '@member/logic/reservaLogic';
import { estadoCupos, type Clase } from '@member/logic/claseAdapter';
import { CupoBar } from './CupoBar';

interface Props {
  clase: Clase;
  yaReservada: boolean;
  puedeReservar: boolean;
  reservando?: boolean;
  onReservar: () => void;
  onCancelar?: () => void;
}

/** Row grande para la lista de agenda semanal. Mobile: hora + info + acción.
 *  En mobile angosto la acción cae debajo en stack. */
export function ClaseRow({
  clase,
  yaReservada,
  puedeReservar,
  reservando,
  onReservar,
  onCancelar
}: Props) {
  const navigate = useNavigate();
  const esCancelada = clase.status === 'cancelada';
  const estado = estadoCupos(clase);
  const llena = estado === 'llena';
  const pocos = estado === 'pocos';

  const onRowClick = (e: React.MouseEvent) => {
    // Si el click fue en el botón derecho, no navegamos
    if ((e.target as HTMLElement).closest('button')) return;
    navigate(`/app/clase/${encodeURIComponent(clase.id)}`);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onRowClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          if ((e.target as HTMLElement).tagName !== 'BUTTON') {
            e.preventDefault();
            navigate(`/app/clase/${encodeURIComponent(clase.id)}`);
          }
        }
      }}
      style={{
        display: 'grid',
        gridTemplateColumns: '76px 1fr',
        gap: '14px',
        padding: '16px 18px',
        background: esCancelada ? 'var(--sala-bg)' : 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderLeft: esCancelada
          ? '3px solid var(--sala-text-tertiary)'
          : yaReservada
            ? '3px solid var(--sala-primary)'
            : pocos
              ? '3px solid var(--sala-accent)'
              : '1px solid var(--sala-border)',
        borderRadius: '14px',
        cursor: 'pointer',
        transition: 'border-color 0.18s ease, transform 0.12s ease, box-shadow 0.18s ease',
        boxShadow: '0 1px 3px rgba(26, 31, 28, 0.04)'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = '0 4px 12px rgba(26, 31, 28, 0.08)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = '0 1px 3px rgba(26, 31, 28, 0.04)';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      {/* Hora + duración */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          minWidth: 0
        }}
      >
        <span
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '24px',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1,
            color: 'var(--sala-text-primary)',
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {formatHora(clase.slotInicio)}
        </span>
        <span
          style={{
            fontSize: '11px',
            color: 'var(--sala-text-tertiary)',
            marginTop: '4px',
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {clase.duracionMinutos} min
        </span>
      </div>

      {/* Info + acción */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          minWidth: 0
        }}
      >
        {/* Encabezado: disciplina (eyebrow) + nombre + instructor */}
        <div style={{ minWidth: 0 }}>
          {clase.disciplina && clase.disciplina !== clase.nombre && (
            <p
              style={{
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--sala-primary)',
                margin: 0,
                marginBottom: '4px'
              }}
            >
              {clase.disciplina}
            </p>
          )}
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '16px',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: 'var(--sala-text-primary)',
              margin: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textDecoration: esCancelada ? 'line-through' : 'none',
              opacity: esCancelada ? 0.6 : 1
            }}
          >
            {clase.nombre}
          </p>
          <p
            style={{
              fontSize: '13px',
              color: 'var(--sala-text-secondary)',
              margin: 0,
              marginTop: '2px'
            }}
          >
            {clase.instructorNombre ? `con ${clase.instructorNombre}` : 'Instructor por confirmar'}
          </p>
        </div>

        {/* Cupos + acción */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            flexWrap: 'wrap'
          }}
        >
          <div style={{ flex: '1 1 120px', minWidth: '100px' }}>
            <CupoBar clase={clase} size="md" />
          </div>
          <ActionButton
            cancelada={esCancelada}
            yaReservada={yaReservada}
            puedeReservar={puedeReservar}
            llena={llena}
            pocos={pocos}
            reservando={!!reservando}
            onReservar={onReservar}
            onCancelar={onCancelar}
          />
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  cancelada,
  yaReservada,
  puedeReservar,
  llena,
  pocos,
  reservando,
  onReservar,
  onCancelar
}: {
  cancelada: boolean;
  yaReservada: boolean;
  puedeReservar: boolean;
  llena: boolean;
  pocos: boolean;
  reservando: boolean;
  onReservar: () => void;
  onCancelar?: () => void;
}) {
  const baseStyle: React.CSSProperties = {
    minHeight: '40px',
    padding: '0 16px',
    fontSize: '13px',
    fontWeight: 600,
    borderRadius: '999px',
    cursor: 'pointer',
    border: '1px solid transparent',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    transition: 'background 0.18s ease, border-color 0.18s ease, color 0.18s ease'
  };

  if (cancelada) {
    return (
      <button
        type="button"
        disabled
        style={{
          ...baseStyle,
          background: 'var(--sala-bg)',
          color: 'var(--sala-text-tertiary)',
          borderColor: 'var(--sala-border)',
          cursor: 'not-allowed'
        }}
      >
        Clase cancelada
      </button>
    );
  }

  if (yaReservada) {
    return (
      <button
        type="button"
        onClick={onCancelar}
        disabled={!onCancelar || reservando}
        style={{
          ...baseStyle,
          background: 'transparent',
          color: 'var(--sala-primary)',
          borderColor: 'var(--sala-primary)'
        }}
      >
        Reservado ✓
      </button>
    );
  }

  if (llena) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onReservar();
        }}
        style={{
          ...baseStyle,
          background: 'transparent',
          color: 'var(--sala-accent)',
          borderColor: 'var(--sala-accent)'
        }}
      >
        Lista de espera
      </button>
    );
  }

  if (!puedeReservar) {
    return (
      <button
        type="button"
        disabled
        title="Tu plan no incluye esta sala"
        style={{
          ...baseStyle,
          background: 'var(--sala-bg)',
          color: 'var(--sala-text-tertiary)',
          borderColor: 'var(--sala-border)',
          cursor: 'not-allowed'
        }}
      >
        Sin acceso
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onReservar();
      }}
      disabled={reservando}
      style={{
        ...baseStyle,
        background: pocos ? 'var(--sala-accent)' : 'var(--sala-primary)',
        color: 'var(--sala-text-on-primary)',
        borderColor: pocos ? 'var(--sala-accent)' : 'var(--sala-primary)',
        opacity: reservando ? 0.6 : 1
      }}
    >
      {reservando ? 'Reservando…' : 'Reservar'}
    </button>
  );
}
