import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { useDashboardData, type DashboardData } from '../hooks/useAdminData';
import CardMenuDropdown from '../components/CardMenuDropdown';
import CancelarReservaModal, { type ReservaParaCancelar } from '../components/CancelarReservaModal';

function capitalizar(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function saludoTiming(d: Date = new Date()): { texto: string; emoji: string } {
  const h = d.getHours();
  if (h >= 5 && h < 12) return { texto: 'Buenos días', emoji: '☀️' };
  if (h >= 12 && h < 19) return { texto: 'Buenas tardes', emoji: '🌤' };
  return { texto: 'Buenas noches', emoji: '🌙' };
}

function nombreMes(d: Date): string {
  return d.toLocaleDateString('es-MX', { month: 'long' });
}

function calcTendencia(actual: number, anterior: number): number | null {
  if (anterior === 0) return null;
  return ((actual - anterior) / anterior) * 100;
}

export default function AdminDashboard() {
  const { usuario } = useAuth();
  const { data, isLoading, refetch } = useDashboardData();
  const [cancelar, setCancelar] = useState<ReservaParaCancelar | null>(null);

  const saludo = saludoTiming();
  const nombre = capitalizar(usuario?.nombre).split(' ')[0] || '';

  if (isLoading || !data) {
    return (
      <div>
        <div className="ek-skeleton" style={{ height: '40px', width: '260px', marginBottom: '12px' }} />
        <div className="ek-skeleton" style={{ height: '20px', width: '180px', marginBottom: '32px' }} />
        <div className="ek-skeleton" style={{ height: '300px', marginBottom: '20px' }} />
        <div className="ek-skeleton" style={{ height: '200px' }} />
      </div>
    );
  }

  return (
    <div>
      <h1
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(32px, 5vw, 48px)',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          lineHeight: 1.05,
          margin: 0,
          marginBottom: '6px'
        }}
      >
        Hoy en EKKO
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '36px' }}>
        {saludo.texto}{nombre ? `, ${nombre}` : ''} {saludo.emoji}
      </p>

      <SeccionHoy data={data} onCancelar={setCancelar} />
      <SeccionTuMes data={data} />
      <SeccionDinero />

      {cancelar && (
        <CancelarReservaModal
          reserva={cancelar}
          onClose={() => setCancelar(null)}
          onCancelled={async () => {
            await refetch();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// SECCIÓN HOY
// ============================================================================

function SeccionHoy({
  data,
  onCancelar
}: {
  data: DashboardData;
  onCancelar: (r: ReservaParaCancelar) => void;
}) {
  const toast = useToast();
  const hoy = new Date();
  const fechaFmt = hoy.toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });

  const top = data.reservasHoy.slice(0, 3);
  const total = data.reservasHoy.length;

  return (
    <section style={{ marginBottom: '32px' }}>
      <SectionHeader title="HOY" subtitle={fechaFmt.charAt(0).toUpperCase() + fechaFmt.slice(1)} />

      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '28px',
          fontWeight: 600,
          letterSpacing: '-0.02em',
          margin: 0,
          marginBottom: '4px'
        }}
      >
        {total} {total === 1 ? 'reserva hoy' : 'reservas hoy'}
      </p>
      {total === 0 ? (
        <p className="ek-body-faint" style={{ marginBottom: '0' }}>
          No hay reservas para hoy.
        </p>
      ) : (
        <>
          <p
            className="ek-eyebrow"
            style={{ fontSize: '10px', marginTop: '20px', marginBottom: '12px' }}
          >
            PRÓXIMAS
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {top.map((r) => {
              const fecha = new Date(r.slot_inicio);
              const hora = fecha.toLocaleTimeString('es-MX', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
              });
              const nombre = capitalizar(r.usuario?.nombre) || r.usuario?.email || '—';
              const tier = r.usuario?.membresia_tier ?? null;
              const recursoNombre = r.recurso?.nombre ?? '—';

              return (
                <div
                  key={r.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                    background: 'var(--ek-bg-soft)',
                    border: '0.5px solid var(--ek-line)',
                    borderRadius: '14px',
                    padding: '14px 18px'
                  }}
                >
                  <div style={{ minWidth: '64px' }}>
                    <p
                      style={{
                        fontFamily: 'var(--ek-font-display)',
                        fontSize: '20px',
                        fontWeight: 700,
                        letterSpacing: '-0.02em',
                        margin: 0,
                        color: 'var(--ek-ink)'
                      }}
                    >
                      {hora}
                    </p>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p
                      style={{
                        fontFamily: 'var(--ek-font-display)',
                        fontSize: '15px',
                        fontWeight: 600,
                        letterSpacing: '-0.02em',
                        margin: 0,
                        marginBottom: '2px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {nombre}
                    </p>
                    <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0 }}>
                      {recursoNombre}
                      {tier ? ` · ${tier}` : ''}
                    </p>
                  </div>
                  <CardMenuDropdown
                    items={[
                      {
                        label: 'Ver detalle',
                        icon: '👁',
                        onClick: () => toast.info('Detalle de reserva: pendiente Sprint Reservas.')
                      },
                      {
                        label: 'Cancelar reserva',
                        icon: '🚫',
                        onClick: () =>
                          onCancelar({
                            id: r.id,
                            slot_inicio: r.slot_inicio,
                            recurso_nombre: recursoNombre,
                            usuario_nombre: nombre,
                            tier
                          }),
                        danger: true,
                        divider: true
                      }
                    ]}
                  />
                </div>
              );
            })}
          </div>
          {total > 3 && (
            <Link
              to="/admin/calendario"
              style={{
                display: 'inline-block',
                marginTop: '14px',
                fontSize: '13px',
                color: 'var(--ek-mustard)',
                textDecoration: 'none',
                fontWeight: 600
              }}
            >
              Ver todas las {total} reservas →
            </Link>
          )}
        </>
      )}
    </section>
  );
}

// ============================================================================
// SECCIÓN TU MES
// ============================================================================

function SeccionTuMes({ data }: { data: DashboardData }) {
  const ahora = new Date();
  const mesActual = nombreMes(ahora);
  const mesAnteriorDate = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1);
  const mesAnteriorNombre = nombreMes(mesAnteriorDate);

  const tendenciaReservas = calcTendencia(
    data.reservasMesActual,
    data.reservasMesAnterior
  );
  const tendenciaMiembros = calcTendencia(
    data.miembrosNuevosMesActual,
    data.miembrosNuevosMesAnterior
  );

  // No-shows: comparar % no-show
  const pctActual =
    data.reservasMesActual > 0
      ? Math.round((data.noShowsMesActual / data.reservasMesActual) * 100)
      : 0;
  const pctAnterior =
    data.totalReservasMesAnteriorParaNoShows > 0
      ? Math.round(
          (data.noShowsMesAnterior / data.totalReservasMesAnteriorParaNoShows) * 100
        )
      : 0;
  const tendenciaNoShows = pctAnterior === 0 ? null : pctActual - pctAnterior;

  return (
    <section style={{ marginBottom: '32px' }}>
      <SectionHeader
        title="ESTE MES"
        subtitle={`${mesActual.charAt(0).toUpperCase() + mesActual.slice(1)} ${ahora.getFullYear()}`}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '12px',
          marginBottom: '20px'
        }}
      >
        <MetricaCard
          valor={data.reservasMesActual}
          label="RESERVAS"
          tendencia={tendenciaReservas}
          mesAnteriorNombre={mesAnteriorNombre}
        />
        <MetricaCard
          valor={data.miembrosNuevosMesActual}
          label="MIEMBROS NUEVOS"
          tendencia={tendenciaMiembros}
          mesAnteriorNombre={mesAnteriorNombre}
        />
        <MetricaCard
          valor={`${pctActual}%`}
          label="NO-SHOWS"
          tendencia={tendenciaNoShows}
          tendenciaInversa
          mesAnteriorNombre={mesAnteriorNombre}
          subtexto={`${data.noShowsMesActual} de ${data.reservasMesActual}`}
        />
      </div>

      <Grafica30Dias data={data.reservasUltimos30Dias} />
    </section>
  );
}

function MetricaCard({
  valor,
  label,
  tendencia,
  tendenciaInversa = false,
  mesAnteriorNombre,
  subtexto
}: {
  valor: number | string;
  label: string;
  tendencia: number | null;
  tendenciaInversa?: boolean;
  mesAnteriorNombre: string;
  subtexto?: string;
}) {
  let tendenciaTexto = '';
  let tendenciaColor = 'var(--ek-ink-faint)';

  if (tendencia === null) {
    tendenciaTexto = 'Primer mes 🎉';
  } else {
    const abs = Math.abs(tendencia).toFixed(0);
    const flecha = tendencia >= 0 ? '↑' : '↓';
    const positivo = tendenciaInversa ? tendencia <= 0 : tendencia >= 0;
    tendenciaColor = positivo ? 'var(--ek-success)' : 'var(--ek-danger)';
    tendenciaTexto = `${flecha} ${abs}% vs ${mesAnteriorNombre}`;
  }

  return (
    <div
      className="ek-card"
      style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '6px' }}
    >
      <p className="ek-eyebrow" style={{ fontSize: '10px', margin: 0 }}>{label}</p>
      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '36px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          lineHeight: 1,
          margin: 0
        }}
      >
        {valor}
      </p>
      <p style={{ fontSize: '12px', color: tendenciaColor, margin: 0, fontWeight: 600 }}>
        {tendenciaTexto}
      </p>
      {subtexto && (
        <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', margin: 0 }}>{subtexto}</p>
      )}
    </div>
  );
}

function Grafica30Dias({ data }: { data: Array<{ fecha: string; count: number }> }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const WIDTH = 600;
  const HEIGHT = 120;
  const BAR_W = WIDTH / data.length;
  const PAD = 1;

  return (
    <div
      className="ek-card"
      style={{ padding: '20px' }}
    >
      <p className="ek-eyebrow" style={{ fontSize: '10px', marginBottom: '12px' }}>
        RESERVAS · ÚLTIMOS 30 DÍAS
      </p>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        height={HEIGHT}
        preserveAspectRatio="none"
        style={{ display: 'block' }}
        role="img"
        aria-label="Reservas por día en los últimos 30 días"
      >
        {data.map((d, i) => {
          const h = (d.count / max) * (HEIGHT - 10);
          return (
            <g key={d.fecha}>
              <rect
                x={i * BAR_W + PAD}
                y={HEIGHT - h}
                width={BAR_W - PAD * 2}
                height={h}
                fill="var(--ek-mustard)"
                opacity={d.count === 0 ? 0.15 : 0.85}
                rx={2}
              >
                <title>
                  {d.count} {d.count === 1 ? 'reserva' : 'reservas'} ·{' '}
                  {new Date(d.fecha).toLocaleDateString('es-MX', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short'
                  })}
                </title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: '10px',
          color: 'var(--ek-ink-faint)',
          marginTop: '6px'
        }}
      >
        <span>Hace 30 días</span>
        <span>Hoy</span>
      </div>
    </div>
  );
}

// ============================================================================
// SECCIÓN DINERO
// ============================================================================

function SeccionDinero() {
  const toast = useToast();
  return (
    <section style={{ marginBottom: '24px' }}>
      <SectionHeader title="DINERO" subtitle="Pendiente Stripe" />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '12px',
          marginBottom: '14px'
        }}
      >
        <DisabledCard label="FACTURADO ESTE MES" />
        <DisabledCard label="COBROS FALLIDOS" />
      </div>
      <div
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px dashed var(--ek-mustard-dim)',
          borderRadius: 'var(--ek-r-md)',
          padding: '16px 18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          flexWrap: 'wrap'
        }}
      >
        <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>
          Conecta Stripe para ver tus métricas financieras.
        </p>
        <button
          type="button"
          disabled
          onClick={() =>
            toast.info('Sprint Stripe pendiente. Se implementa próximamente.')
          }
          className="ek-cta ek-cta--secondary"
          style={{ padding: '10px 18px', fontSize: '12px', opacity: 0.6, cursor: 'not-allowed' }}
        >
          + Conectar Stripe (próximamente)
        </button>
      </div>
    </section>
  );
}

function DisabledCard({ label }: { label: string }) {
  return (
    <div
      className="ek-card"
      title="Disponible al conectar Stripe"
      style={{
        padding: '20px',
        opacity: 0.5,
        cursor: 'not-allowed',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px'
      }}
    >
      <p className="ek-eyebrow" style={{ fontSize: '10px', margin: 0 }}>{label}</p>
      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '36px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          lineHeight: 1,
          margin: 0
        }}
      >
        —
      </p>
      <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', margin: 0 }}>
        Conecta Stripe para ver
      </p>
    </div>
  );
}

// ============================================================================
// Header de sección reusable
// ============================================================================

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <p
        className="ek-eyebrow ek-eyebrow--mustard"
        style={{ fontSize: '11px', marginBottom: '2px' }}
      >
        {title}
      </p>
      <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>{subtitle}</p>
    </div>
  );
}
