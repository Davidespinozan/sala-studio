import { estadoCupos, type Clase } from '@member/logic/claseAdapter';

interface Props {
  clase: Pick<Clase, 'cupoMax' | 'cuposReservados'>;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
}

/** Barra de progreso de cupos. Verde salvia normal, coral si quedan ≤3, gris si llena. */
export function CupoBar({ clase, size = 'md', showLabel = true }: Props) {
  const { cupoMax, cuposReservados } = clase;
  const cuposLibres = Math.max(0, cupoMax - cuposReservados);
  const pct = Math.min(100, (cuposReservados / cupoMax) * 100);
  const estado = estadoCupos({ cupoMax, cuposReservados } as Clase);

  const colorMap: Record<string, string> = {
    disponible: 'var(--sala-primary)',
    pocos: 'var(--sala-accent)',
    llena: 'var(--sala-text-tertiary)'
  };
  const color = colorMap[estado];

  const height = size === 'sm' ? 4 : size === 'lg' ? 10 : 6;

  const label = estado === 'llena'
    ? 'Clase llena'
    : estado === 'pocos'
      ? `¡Quedan ${cuposLibres}!`
      : `${cuposReservados}/${cupoMax}`;

  return (
    <div style={{ width: '100%' }}>
      <div
        role="progressbar"
        aria-valuenow={cuposReservados}
        aria-valuemin={0}
        aria-valuemax={cupoMax}
        aria-label="Cupos reservados"
        style={{
          height: `${height}px`,
          background: 'var(--sala-border)',
          borderRadius: '999px',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            borderRadius: '999px',
            transition: 'width 0.3s ease, background 0.3s ease'
          }}
        />
      </div>
      {showLabel && (
        <p
          style={{
            fontSize: '12px',
            color: estado === 'disponible' ? 'var(--sala-text-secondary)' : color,
            marginTop: '4px',
            marginBottom: 0,
            fontVariantNumeric: 'tabular-nums',
            fontWeight: estado === 'disponible' ? 500 : 600
          }}
        >
          {label}
        </p>
      )}
    </div>
  );
}
