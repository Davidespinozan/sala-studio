import { useMemo } from 'react';
import { formatHora } from '@member/logic/reservaLogic';
import { estadoCupos, type Clase } from '@member/logic/claseAdapter';
import { DayTabSelector } from '@member/components/DayTabSelector';

interface Props {
  clases: Clase[]; // todas las clases de la semana
  fechaSel: string; // YYYY-MM-DD
  fechas: Array<{ fechaISO: string; date: Date }>;
  onFechaSelChange: (f: string) => void;
  onClickClase: (clase: Clase) => void;
}

/** Vista mobile: tabs de día + lista vertical de clases del día seleccionado. */
export function AgendaListaDia({
  clases,
  fechaSel,
  fechas,
  onFechaSelChange,
  onClickClase
}: Props) {
  const clasesDia = useMemo(() => {
    return clases
      .filter((c) => {
        const d = c.slotInicio;
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return iso === fechaSel;
      })
      .sort((a, b) => a.slotInicio.getTime() - b.slotInicio.getTime());
  }, [clases, fechaSel]);

  return (
    <div>
      <div style={{ marginBottom: '20px' }}>
        <DayTabSelector
          fechas={fechas}
          selectedFechaISO={fechaSel}
          onSelect={onFechaSelChange}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {clasesDia.length === 0 ? (
          <div
            style={{
              padding: '48px 20px',
              textAlign: 'center',
              background: 'var(--sala-surface)',
              border: '1px solid var(--sala-border)',
              borderRadius: '14px'
            }}
          >
            <p
              style={{
                fontSize: '11px',
                fontWeight: 700,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--sala-text-tertiary)',
                margin: 0,
                marginBottom: '8px'
              }}
            >
              Sin clases
            </p>
            <p
              style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '16px',
                fontWeight: 600,
                color: 'var(--sala-text-primary)',
                margin: 0
              }}
            >
              No hay clases programadas para este día.
            </p>
          </div>
        ) : (
          clasesDia.map((clase) => (
            <ClaseRowAdminMobile key={clase.id} clase={clase} onClick={() => onClickClase(clase)} />
          ))
        )}
      </div>
    </div>
  );
}

function ClaseRowAdminMobile({ clase, onClick }: { clase: Clase; onClick: () => void }) {
  const esCancelada = clase.status === 'cancelada';
  const estado = estadoCupos(clase);
  const llena = estado === 'llena';
  const pocos = estado === 'pocos';
  const colorCupo = llena
    ? 'var(--sala-text-tertiary)'
    : pocos
      ? 'var(--sala-accent)'
      : 'var(--sala-text-secondary)';

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: '76px 1fr auto',
        gap: '14px',
        padding: '16px 18px',
        background: esCancelada ? 'var(--sala-bg)' : 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderLeft: esCancelada
          ? '3px solid var(--sala-text-tertiary)'
          : pocos
            ? '3px solid var(--sala-accent)'
            : llena
              ? '3px solid var(--sala-text-tertiary)'
              : '3px solid var(--sala-primary)',
        borderRadius: '14px',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        width: '100%',
        boxShadow: '0 1px 3px rgba(26, 31, 28, 0.04)',
        transition: 'border-color 0.18s ease, transform 0.12s ease, box-shadow 0.18s ease'
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0 }}>
        <span
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '22px',
            fontWeight: 700,
            color: 'var(--sala-text-primary)',
            letterSpacing: '-0.02em',
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1
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
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <p
          style={{
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: esCancelada ? 'var(--sala-text-tertiary)' : 'var(--sala-primary)',
            margin: 0,
            marginBottom: '2px'
          }}
        >
          {esCancelada ? 'Cancelada' : clase.disciplina}
        </p>
        <p
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '15px',
            fontWeight: 600,
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
            fontSize: '12px',
            color: 'var(--sala-text-secondary)',
            margin: 0,
            marginTop: '2px'
          }}
        >
          con {clase.instructor}
        </p>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          justifyContent: 'center',
          gap: '4px'
        }}
      >
        <span
          style={{
            fontSize: '14px',
            fontWeight: 700,
            color: colorCupo,
            fontVariantNumeric: 'tabular-nums',
            fontFamily: 'var(--ek-font-display)',
            letterSpacing: '-0.02em'
          }}
        >
          {llena
            ? 'Llena'
            : pocos
              ? `¡${clase.cupoMax - clase.cuposReservados}!`
              : `${clase.cuposReservados}/${clase.cupoMax}`}
        </span>
        <span
          style={{
            fontSize: '10px',
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--sala-primary)'
          }}
        >
          Ver inscritos →
        </span>
      </div>
    </button>
  );
}
