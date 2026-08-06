import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Ban,
  CloudSun,
  Eye,
  Moon,
  PartyPopper,
  Sun,
  TrendingDown,
  TrendingUp,
  type LucideIcon
} from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { useDashboardData, type DashboardData } from '../hooks/useAdminData';
import { useDineroMes } from '../hooks/useDineroMes';
import { getTenantTimezone, hoyEnTimezone } from '@shared/lib/timezone';
import { formatearMoneda } from '@shared/lib/dinero';
import { useGymSetup, gymOperativo } from '../hooks/useGymSetup';
import ChecklistActivacion from '../components/ChecklistActivacion';
import CentroPendientes from '../components/CentroPendientes';
import CardMenuDropdown from '../components/CardMenuDropdown';
import CancelarReservaModal, { type ReservaParaCancelar } from '../components/CancelarReservaModal';
import { InfoTooltip } from '../components/InfoTooltip';

function capitalizar(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function saludoTiming(d: Date = new Date()): { texto: string; Icon: LucideIcon } {
  const h = d.getHours();
  if (h >= 5 && h < 12) return { texto: 'Buenos días', Icon: Sun };
  if (h >= 12 && h < 19) return { texto: 'Buenas tardes', Icon: CloudSun };
  return { texto: 'Buenas noches', Icon: Moon };
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
  const tenant = useTenant();
  const { data, isLoading, refetch } = useDashboardData();
  const { setup } = useGymSetup();
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
      <div className="adm-hero">
        <p className="adm-hero-eyebrow">Panel de control</p>
        {/* El nombre del GYM, no "SALA": el admin de Numa veía "Hoy en SALA". */}
        <h1 className="adm-hero-title">Hoy en {tenant.nombre || 'tu gym'}</h1>
        <p className="adm-hero-subtitle" style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
          {saludo.texto}{nombre ? `, ${nombre}` : ''}
          <saludo.Icon size={17} strokeWidth={2.25} style={{ color: 'var(--ek-mustard)' }} />
        </p>
      </div>

      {setup && !gymOperativo(setup) && <ChecklistActivacion setup={setup} />}
      {setup && gymOperativo(setup) && <CentroPendientes />}

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
  const tz = getTenantTimezone(useTenant());
  const hoy = new Date();
  const fechaFmt = hoy.toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: tz
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
        <p style={{ marginBottom: '0', fontSize: '14px', color: 'var(--sala-text-secondary)' }}>
          Día tranquilo. Mira la <Link to="/admin/calendario" style={{ color: 'var(--sala-primary)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px', verticalAlign: 'bottom' }}>agenda completa<ArrowRight size={14} strokeWidth={2.25} /></Link>
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
                hour12: false,
                timeZone: tz
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
                        icon: <Eye size={15} />,
                        onClick: () => toast.info('Para ver el detalle completo, ve a la pantalla de Reservas.')
                      },
                      {
                        label: 'Cancelar reserva',
                        icon: <Ban size={15} />,
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
                display: 'inline-flex',
                marginTop: '14px',
                fontSize: '13px',
                color: 'var(--ek-mustard)',
                textDecoration: 'none',
                fontWeight: 600,
                alignItems: 'center',
                gap: '5px'
              }}
            >
              Ver todas las {total} reservas
              <ArrowRight size={14} strokeWidth={2.25} />
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
  // El mes es el del GYM, no el del navegador (importa cerca del cambio de mes).
  const [anioGym, mesGym] = hoyEnTimezone(getTenantTimezone(useTenant())).split('-').map(Number);
  const ahora = new Date(anioGym, mesGym - 1, 1);
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
          ayuda="Reservas que ocurrieron este mes: confirmadas, completadas y no-shows. No cuenta las canceladas. La flecha compara con el mes anterior."
        />
        <MetricaCard
          valor={data.miembrosNuevosMesActual}
          label="MIEMBROS NUEVOS"
          tendencia={tendenciaMiembros}
          mesAnteriorNombre={mesAnteriorNombre}
          ayuda="Socios nuevos que se dieron de alta este mes. La flecha compara con el mes anterior."
        />
        <MetricaCard
          valor={`${pctActual}%`}
          label="NO-SHOWS"
          tendencia={tendenciaNoShows}
          tendenciaInversa
          mesAnteriorNombre={mesAnteriorNombre}
          subtexto={`${data.noShowsMesActual} de ${data.reservasMesActual}`}
          ayuda="De las reservas del mes, qué % no se presentó ni canceló a tiempo. Menos es mejor: cada no-show quema un cupo que otro socio pudo usar."
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
  subtexto,
  ayuda
}: {
  valor: number | string;
  label: string;
  tendencia: number | null;
  tendenciaInversa?: boolean;
  mesAnteriorNombre: string;
  subtexto?: string;
  ayuda?: string;
}) {
  let tendenciaTexto = '';
  let tendenciaColor = 'var(--ek-ink-faint)';
  let TendenciaIcon: LucideIcon = PartyPopper;

  if (tendencia === null) {
    tendenciaTexto = 'Primer mes';
  } else {
    const abs = Math.abs(tendencia).toFixed(0);
    TendenciaIcon = tendencia >= 0 ? TrendingUp : TrendingDown;
    const positivo = tendenciaInversa ? tendencia <= 0 : tendencia >= 0;
    tendenciaColor = positivo ? 'var(--ek-success)' : 'var(--ek-danger)';
    tendenciaTexto = `${abs}% vs ${mesAnteriorNombre}`;
  }

  return (
    <div
      className="ek-card"
      style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '6px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
        <p className="ek-eyebrow" style={{ fontSize: '10px', margin: 0 }}>{label}</p>
        {ayuda && <InfoTooltip titulo={label} texto={ayuda} />}
      </div>
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
      <p style={{ fontSize: '12px', color: tendenciaColor, margin: 0, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
        <TendenciaIcon size={13} strokeWidth={2.5} />
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
  const total = data.reduce((s, d) => s + d.count, 0);
  const pico = data.length ? Math.max(...data.map((d) => d.count)) : 0;
  const WIDTH = 600;
  const HEIGHT = 120;
  const BAR_W = WIDTH / data.length;
  const PAD = 1;

  return (
    <div
      className="ek-card"
      style={{ padding: '20px' }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <p className="ek-eyebrow" style={{ fontSize: '10px', margin: 0, display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          RESERVAS · ÚLTIMOS 30 DÍAS
          <InfoTooltip
            titulo="Reservas últimos 30 días"
            texto="Cada barra es un día; qué tan alta = cuántas reservas hubo ese día. Pasa el cursor por una barra para ver el número exacto. A la derecha, el total del período y el día más movido (pico)."
          />
        </p>
        <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', fontVariantNumeric: 'tabular-nums' }}>
          {total} en total · pico {pico}/día
        </span>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        height={HEIGHT}
        preserveAspectRatio="none"
        style={{ display: 'block' }}
        role="img"
        aria-label="Reservas por día en los últimos 30 días"
      >
        {/* Línea base en 0: los días sin reservas se leen como "cero", no como vacío. */}
        <rect x={0} y={HEIGHT - 1} width={WIDTH} height={1} fill="var(--ek-line)" />
        {data.map((d, i) => {
          // Todos los días muestran algo: los de 0 quedan como un tick tenue sobre la
          // base, así el mes se ve completo (gym nuevo = muchos días todavía en cero).
          const h = d.count === 0 ? 3 : Math.max(6, (d.count / max) * (HEIGHT - 12));
          return (
            <rect
              key={d.fecha}
              x={i * BAR_W + PAD}
              y={HEIGHT - h}
              width={BAR_W - PAD * 2}
              height={h}
              fill="var(--ek-mustard)"
              opacity={d.count === 0 ? 0.18 : 0.9}
              rx={2}
            >
              <title>
                {d.count} {d.count === 1 ? 'reserva' : 'reservas'} ·{' '}
                {new Date(d.fecha).toLocaleDateString('es-MX', {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                  timeZone: 'UTC'
                })}
              </title>
            </rect>
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
  const { data, isLoading } = useDineroMes();
  const [anioGym, mesGym] = hoyEnTimezone(getTenantTimezone(useTenant())).split('-').map(Number);
  const ahora = new Date(anioGym, mesGym - 1, 1);
  const mes = `${nombreMes(ahora).charAt(0).toUpperCase() + nombreMes(ahora).slice(1)} ${ahora.getFullYear()}`;

  return (
    <section style={{ marginBottom: '24px' }}>
      <SectionHeader title="DINERO" subtitle={mes} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '12px',
          marginBottom: '14px'
        }}
      >
        <DineroCard
          label="COBRADO ESTE MES"
          valor={data ? formatearMoneda(data.cobradoCentavos, data.moneda) : '—'}
          sub={
            data
              ? `${data.transacciones} ${data.transacciones === 1 ? 'cobro' : 'cobros'}${
                  data.devueltoCentavos > 0
                    ? ` · ${formatearMoneda(data.devueltoCentavos, data.moneda)} devueltos`
                    : ''
                }`
              : 'Cargando…'
          }
          loading={isLoading}
          ayuda="Dinero real que entró este mes (efectivo, tarjeta, transferencia, Stripe), ya neto de devoluciones. Es lo que cuadra con la Caja."
        />
        <DineroCard
          label="DEVUELTO ESTE MES"
          valor={data ? formatearMoneda(data.devueltoCentavos, data.moneda) : '—'}
          sub="Reembolsos del mes"
          loading={isLoading}
          ayuda="Reembolsos que hiciste este mes. Ya está descontado del cobrado, no se cuenta doble."
        />
      </div>
      <div
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-md)',
          padding: '14px 18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          flexWrap: 'wrap'
        }}
      >
        <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>
          El detalle de cada cobro, por método y con las devoluciones, está en Caja.
        </p>
        <Link
          to="/admin/caja"
          className="ek-cta ek-cta--secondary"
          style={{ padding: '10px 18px', fontSize: '12px', whiteSpace: 'nowrap' }}
        >
          Ver Caja
        </Link>
      </div>
    </section>
  );
}

function DineroCard({
  label,
  valor,
  sub,
  loading,
  ayuda
}: {
  label: string;
  valor: string;
  sub: string;
  loading: boolean;
  ayuda?: string;
}) {
  return (
    <div
      className="ek-card"
      style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '6px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
        <p className="ek-eyebrow" style={{ fontSize: '10px', margin: 0 }}>{label}</p>
        {ayuda && <InfoTooltip titulo={label} texto={ayuda} />}
      </div>
      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '36px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          lineHeight: 1,
          margin: 0,
          opacity: loading ? 0.4 : 1,
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {valor}
      </p>
      <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', margin: 0 }}>{sub}</p>
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
