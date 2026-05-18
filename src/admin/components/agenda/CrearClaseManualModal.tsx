interface Props {
  fecha: Date;
  hora: number;
  onClose: () => void;
}

/** Placeholder: la creación de clases manuales one-shot necesita modelo de datos
 *  nuevo (tabla `clases_extra` o similar). Queda como TODO S5.
 *  Por ahora solo informa al admin que esa feature está próxima. */
export function CrearClaseManualModal({ fecha, hora, onClose }: Props) {
  const fechaFmt = fecha.toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });

  return (
    <div className="ek-modal-backdrop" onClick={onClose}>
      <div
        className="ek-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '440px' }}
      >
        <div className="ek-modal-handle" />
        <p
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--sala-warning)',
            margin: 0,
            marginBottom: '8px'
          }}
        >
          Próximamente
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: 'var(--sala-text-primary)',
            margin: 0,
            marginBottom: '8px'
          }}
        >
          Crear clase manual
        </h3>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--sala-text-secondary)',
            margin: 0,
            marginBottom: '6px',
            textTransform: 'capitalize',
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {fechaFmt} a las {String(hora).padStart(2, '0')}:00
        </p>
        <p
          style={{
            fontSize: '13px',
            color: 'var(--sala-text-tertiary)',
            margin: 0,
            marginBottom: '20px',
            lineHeight: 1.5
          }}
        >
          La creación de clases manuales fuera del horario regular de las salas
          va a llegar con el modelo de clases real (S5). Por ahora podés editar
          los horarios recurrentes de cada sala en{' '}
          <strong>Salas → editar → Horarios</strong>.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="ek-cta ek-cta--full"
        >
          Entendido
        </button>
      </div>
    </div>
  );
}
