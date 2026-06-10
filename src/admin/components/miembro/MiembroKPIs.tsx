import type { MiembroKPIs as KPIs } from '@admin/hooks/useMiembroKPIs';

interface Props {
  kpis: KPIs | null;
  isLoading: boolean;
}

const UMBRAL_NOSHOWS = 5;

function diasDesde(d: Date): number {
  const ms = Date.now() - d.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function labelUltimaVisita(d: Date | null): string {
  if (!d) return 'Nunca';
  const dias = diasDesde(d);
  if (dias <= 0) return 'Hoy';
  if (dias === 1) return 'Ayer';
  if (dias < 7) return `Hace ${dias} días`;
  if (dias < 30) return `Hace ${Math.floor(dias / 7)} sem`;
  return `Hace ${Math.floor(dias / 30)} mes${Math.floor(dias / 30) === 1 ? '' : 'es'}`;
}

export function MiembroKPIs({ kpis, isLoading }: Props) {
  if (isLoading || !kpis) {
    return (
      <div style={gridStyle}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="ek-skeleton" style={{ height: '92px', borderRadius: '14px' }} />
        ))}
      </div>
    );
  }

  const alertNoShows = kpis.noShows > UMBRAL_NOSHOWS;

  return (
    <div style={gridStyle}>
      <Card
        label="Asistencias este mes"
        value={kpis.asistenciasMes.toString()}
      />
      <Card
        label="Reservas totales"
        value={kpis.totalReservas.toString()}
      />
      <Card
        label="No-shows"
        value={kpis.noShows.toString()}
        hint={alertNoShows ? `Por encima del umbral (${UMBRAL_NOSHOWS})` : undefined}
        alert={alertNoShows}
      />
      <Card
        label="Última visita"
        value={labelUltimaVisita(kpis.ultimaVisita)}
        hint={
          kpis.ultimaVisita
            ? kpis.ultimaVisita.toLocaleDateString('es-MX', {
                day: 'numeric',
                month: 'short'
              })
            : undefined
        }
      />
    </div>
  );
}

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: '12px',
  marginBottom: '32px'
};

function Card({
  label,
  value,
  hint,
  alert
}: {
  label: string;
  value: string;
  hint?: string;
  alert?: boolean;
}) {
  return (
    <div
      style={{
        background: 'var(--sala-surface)',
        border: `1px solid ${alert ? 'var(--sala-warning-glow)' : 'var(--sala-border)'}`,
        borderRadius: '14px',
        padding: '16px 18px',
        boxShadow: '0 1px 3px rgba(26, 31, 28, 0.04)'
      }}
    >
      <p
        style={{
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: alert ? 'var(--sala-accent)' : 'var(--sala-text-tertiary)',
          margin: 0,
          marginBottom: '8px'
        }}
      >
        {label}
      </p>
      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '28px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          color: alert ? 'var(--sala-accent)' : 'var(--sala-text-primary)',
          margin: 0,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1
        }}
      >
        {value}
      </p>
      {hint && (
        <p
          style={{
            fontSize: '11px',
            color: alert ? 'var(--sala-accent)' : 'var(--sala-text-tertiary)',
            margin: 0,
            marginTop: '6px',
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {hint}
        </p>
      )}
    </div>
  );
}
