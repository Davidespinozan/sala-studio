interface Fecha {
  fechaISO: string;
  date: Date;
}

interface Props {
  fechas: Fecha[];
  selectedFechaISO: string;
  onSelect: (fechaISO: string) => void;
}

/** Tabs horizontales con número grande + abreviatura del día (LUN, MAR, ...).
 *  Se reparten el ancho cuando son pocos y hacen scroll horizontal cuando la
 *  ventana de reserva es larga (p. ej. 30 días).
 *  Día seleccionado: fondo salvia + texto blanco.
 *  Día hoy (no seleccionado): borde salvia + texto salvia.
 *  Otros: surface plano + texto secundario. */
export function DayTabSelector({ fechas, selectedFechaISO, onSelect }: Props) {
  const hoyISO = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  })();

  return (
    <div
      role="tablist"
      aria-label="Selector de día"
      style={{
        display: 'flex',
        gap: '6px',
        width: '100%',
        overflowX: 'auto',
        paddingBottom: '4px',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'thin'
      }}
    >
      {fechas.map((f) => {
        const selected = f.fechaISO === selectedFechaISO;
        const esHoy = f.fechaISO.slice(0, 10) === hoyISO;
        const dia = f.date.toLocaleDateString('es-MX', { weekday: 'short' })
          .replace('.', '')
          .slice(0, 3)
          .toUpperCase();
        const num = f.date.getDate();

        const bg = selected
          ? 'var(--grad-accent)'
          : 'var(--sala-surface)';
        const color = selected
          ? 'var(--sala-text-on-accent)'
          : esHoy
            ? 'var(--sala-accent)'
            : 'var(--sala-text-secondary)';
        const border = selected
          ? 'var(--sala-accent)'
          : esHoy
            ? 'var(--sala-accent)'
            : 'var(--sala-border)';

        return (
          <button
            key={f.fechaISO}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(f.fechaISO)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '2px',
              padding: '10px 4px',
              minHeight: '64px',
              // Crecen para llenar el ancho cuando son pocos; se quedan en 52px y
              // el contenedor scrollea cuando la ventana es larga.
              flex: '1 0 52px',
              background: bg,
              color,
              border: `1px solid ${border}`,
              borderRadius: '14px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'background 0.18s ease, border-color 0.18s ease, color 0.18s ease',
              boxShadow: selected
                ? '0 2px 10px var(--sala-accent-dim), inset 0 1px 0 rgba(255, 255, 255, 0.16)'
                : 'none'
            }}
          >
            <span
              style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '20px',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {num}
            </span>
            <span
              style={{
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.1em',
                lineHeight: 1
              }}
            >
              {dia}
            </span>
          </button>
        );
      })}
    </div>
  );
}
