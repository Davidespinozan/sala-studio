import { useState } from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell
} from 'recharts';
import {
  useReportes,
  PERIODO_OPTIONS,
  type PeriodoReporte,
  type ReportesData
} from '../hooks/useReportes';
import {
  useReportesAvanzados,
  type ReportesAvanzadosData,
  type CohorteRetencion,
  type MiembroRiesgo
} from '../hooks/useReportesAvanzados';
import { useTenant } from '@shared/hooks/useTenant';

const SALA_DEFAULT_PRIMARY = '#3D6B52';
// Sin acento propio (regla: solo primario/acento), el default del acento es el
// propio primario — nunca coral. Para distinguir series, los charts usan
// salviaLight como segundo tono del mismo hue.
const SALA_DEFAULT_ACCENT  = '#3D6B52';
// SALVIA_LIGHT se queda hardcoded — recharts necesita un hex liso y el
// derivado --sala-primary-light depende de color-mix() que recharts no
// entiende. Si se vuelve un problema con tenants no-verdes, derivarlo
// JS-side con un mix manual aquí.
const SALVIA_LIGHT = '#a9c4b3';

/**
 * Hook que entrega los colores de chart para recharts.
 * Recharts no entiende CSS vars — necesita hex literal. Este hook lee
 * tenant.branding.color_primary/color_accent y devuelve hex. Si el
 * tenant tiene color custom, los charts se tiñen automáticamente.
 */
function useChartColors() {
  const tenant = useTenant();
  const branding = (tenant.branding ?? {}) as Record<string, unknown>;
  return {
    salvia: typeof branding.color_primary === 'string' ? branding.color_primary : SALA_DEFAULT_PRIMARY,
    coral:  typeof branding.color_accent  === 'string' ? branding.color_accent  : SALA_DEFAULT_ACCENT,
    salviaLight: SALVIA_LIGHT
  };
}

export default function Reportes() {
  const [periodo, setPeriodo] = useState<PeriodoReporte>('mes');
  const { data, isLoading } = useReportes(periodo);
  const { data: avanzado, isLoading: avLoading } = useReportesAvanzados(periodo);

  return (
    <div className="adm-page">
      <div className="adm-page-header" style={{ marginBottom: '20px' }}>
        <p className="ek-eyebrow">REPORTES</p>
        <h1 className="ek-h2">Métricas de tu gimnasio</h1>
      </div>

      {/* Selector de período */}
      <div
        style={{
          display: 'flex',
          gap: '8px',
          flexWrap: 'wrap',
          marginBottom: '24px'
        }}
      >
        {PERIODO_OPTIONS.map((o) => {
          const activo = periodo === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => setPeriodo(o.value)}
              style={{
                padding: '8px 16px',
                minHeight: '36px',
                background: activo ? 'var(--sala-primary)' : 'var(--sala-surface)',
                color: activo ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)',
                border: `1px solid ${activo ? 'var(--sala-primary)' : 'var(--sala-border)'}`,
                borderRadius: '999px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit'
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>

      {isLoading || !data ? (
        <p className="adm-body">Cargando métricas…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
          <BloqueOcupacion data={data} />
          <BloqueMiembros data={data} />
          <BloqueReservas data={data} />
        </div>
      )}

      {/* ───────────────────────── Reportes avanzados ───────────────────────── */}
      <div
        style={{
          marginTop: '40px',
          paddingTop: '28px',
          borderTop: '1px solid var(--sala-border)'
        }}
      >
        <p className="ek-eyebrow" style={{ color: 'var(--sala-primary)' }}>AVANZADO · PRO</p>
        <h2 className="ek-h2" style={{ marginBottom: '4px' }}>Retención y churn</h2>
        <p className="adm-body" style={{ color: 'var(--sala-text-secondary)', marginBottom: '20px' }}>
          Quién se queda, quién se va, y quién está por irse.
        </p>

        {avLoading || !avanzado ? (
          <p className="adm-body">Cargando métricas avanzadas…</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
            <BloqueRetencion av={avanzado} />
            <BloqueMiembrosRiesgo miembros={avanzado.miembrosRiesgo} />
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Bloques básicos (con comparación de período)
// ============================================================================

function BloqueOcupacion({ data }: { data: ReportesData }) {
  const { salvia } = useChartColors();
  const o = data.ocupacion;
  const comp = data.comparacion?.ocupacion ?? null;
  return (
    <Bloque titulo="Ocupación y asistencia">
      <KpiRow>
        <KpiCard
          label="Ocupación promedio"
          valor={`${o.promedioPct}%`}
          comparar={
            comp ? { actual: o.promedioPct, anterior: comp.promedioPct, modo: 'puntos' } : undefined
          }
        />
        <KpiCard
          label="Clases en el período"
          valor={o.totalClases}
          comparar={comp ? { actual: o.totalClases, anterior: comp.totalClases } : undefined}
        />
        <KpiCard
          label="Asistencia"
          valor={o.asistenciaPct == null ? '—' : `${o.asistenciaPct}%`}
          comparar={
            o.asistenciaPct != null && comp?.asistenciaPct != null
              ? { actual: o.asistenciaPct, anterior: comp.asistenciaPct, modo: 'puntos' }
              : undefined
          }
        />
        <KpiCard
          label="No-shows"
          valor={o.noShows}
          alerta={o.noShows > 5}
          comparar={
            comp ? { actual: o.noShows, anterior: comp.noShows, inversa: true } : undefined
          }
        />
      </KpiRow>
      <ChartCard titulo="Ocupación por sala">
        {o.porSala.length === 0 ? (
          <EmptyChart mensaje="Sin clases en el período." />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={o.porSala} margin={{ top: 8, right: 8, bottom: 8, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--sala-border)" vertical={false} />
              <XAxis dataKey="sala" tick={{ fontSize: 12 }} stroke="var(--sala-text-tertiary)" />
              <YAxis
                unit="%"
                domain={[0, 100]}
                tick={{ fontSize: 12 }}
                stroke="var(--sala-text-tertiary)"
              />
              <Tooltip formatter={(v) => [`${v}%`, 'Ocupación']} />
              <Bar dataKey="ocupacionPct" name="Ocupación" radius={[6, 6, 0, 0]} fill={salvia} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </Bloque>
  );
}

function BloqueMiembros({ data }: { data: ReportesData }) {
  const { salvia } = useChartColors();
  const m = data.miembros;
  const comp = data.comparacion?.miembros ?? null;
  return (
    <Bloque titulo="Miembros">
      <KpiRow>
        {/* activos/bajas/total son snapshots — su comparación real está en
            el bloque avanzado (vía historial). Acá van sin flecha. */}
        <KpiCard label="Miembros activos" valor={m.activos} />
        <KpiCard
          label="Altas nuevas"
          valor={m.altasNuevas}
          comparar={comp ? { actual: m.altasNuevas, anterior: comp.altasNuevas } : undefined}
        />
        <KpiCard label="Bajas" valor={m.bajas} />
        <KpiCard label="Total de miembros" valor={m.total} />
      </KpiRow>
      <ChartCard titulo="Miembros por plan">
        {m.porPlan.length === 0 ? (
          <EmptyChart mensaje="Sin miembros todavía." />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={m.porPlan} margin={{ top: 8, right: 8, bottom: 8, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--sala-border)" vertical={false} />
              <XAxis dataKey="plan" tick={{ fontSize: 12 }} stroke="var(--sala-text-tertiary)" />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 12 }}
                stroke="var(--sala-text-tertiary)"
              />
              <Tooltip formatter={(v) => [v, 'Miembros']} />
              <Bar dataKey="cantidad" name="Miembros" radius={[6, 6, 0, 0]} fill={salvia} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </Bloque>
  );
}

function BloqueReservas({ data }: { data: ReportesData }) {
  const { salvia, salviaLight } = useChartColors();
  const r = data.reservas;
  const comp = data.comparacion?.reservas ?? null;
  return (
    <Bloque titulo="Reservas">
      <KpiRow>
        <KpiCard
          label="Total de reservas"
          valor={r.total}
          comparar={comp ? { actual: r.total, anterior: comp.total } : undefined}
        />
        <KpiCard
          label="Confirmadas"
          valor={r.confirmadas}
          comparar={comp ? { actual: r.confirmadas, anterior: comp.confirmadas } : undefined}
        />
        <KpiCard
          label="Canceladas"
          valor={r.canceladas}
          comparar={
            comp ? { actual: r.canceladas, anterior: comp.canceladas, inversa: true } : undefined
          }
        />
        <KpiCard
          label="Promedio por día"
          valor={r.promedioPorDia}
          comparar={
            comp ? { actual: r.promedioPorDia, anterior: comp.promedioPorDia } : undefined
          }
        />
      </KpiRow>
      <ChartCard titulo="Reservas por día">
        {r.total === 0 ? (
          <EmptyChart mensaje="Sin reservas en el período." />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={r.porDia} margin={{ top: 8, right: 8, bottom: 8, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--sala-border)" vertical={false} />
              <XAxis
                dataKey="fecha"
                tickFormatter={(f: string) => `${Number(f.slice(8))}/${Number(f.slice(5, 7))}`}
                tick={{ fontSize: 11 }}
                stroke="var(--sala-text-tertiary)"
                interval="preserveStartEnd"
                minTickGap={16}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 12 }}
                stroke="var(--sala-text-tertiary)"
              />
              <Tooltip formatter={(v) => [v, 'Reservas']} />
              <Bar dataKey="cantidad" name="Reservas" radius={[4, 4, 0, 0]}>
                {r.porDia.map((d) => (
                  <Cell key={d.fecha} fill={d.cantidad > 0 ? salvia : salviaLight} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </Bloque>
  );
}

// ============================================================================
// Bloques avanzados
// ============================================================================

function BloqueRetencion({ av }: { av: ReportesAvanzadosData }) {
  const { churn, miembrosActivos, retencion3m, cohortes } = av;
  return (
    <Bloque titulo="Retención y churn">
      <KpiRow>
        <KpiCard
          label="Miembros activos"
          valor={miembrosActivos.actual}
          comparar={{ actual: miembrosActivos.actual, anterior: miembrosActivos.anterior }}
        />
        <KpiCard
          label="Bajas en el período"
          valor={churn.bajas}
          alerta={churn.bajas > 0}
          nota={`de ${churn.activosInicio} activos al inicio`}
          comparar={{ actual: churn.bajas, anterior: churn.bajasAnterior, inversa: true }}
        />
        <KpiCard
          label="Tasa de churn"
          valor={churn.tasaChurnPct == null ? '—' : `${churn.tasaChurnPct}%`}
          alerta={churn.tasaChurnPct != null && churn.tasaChurnPct > 10}
          comparar={
            churn.tasaChurnPct != null && churn.tasaChurnPctAnterior != null
              ? {
                  actual: churn.tasaChurnPct,
                  anterior: churn.tasaChurnPctAnterior,
                  inversa: true,
                  modo: 'puntos'
                }
              : undefined
          }
        />
        <KpiCard
          label="Retención 3 meses"
          valor={retencion3m.pct == null ? '—' : `${retencion3m.pct}%`}
          nota={
            retencion3m.tamanoCohorte > 0
              ? `cohorte ${retencion3m.label} · ${retencion3m.tamanoCohorte} miembros`
              : `sin altas en ${retencion3m.label}`
          }
        />
      </KpiRow>
      <ChartCard titulo="Retención por cohorte de alta">
        <TablaCohortes cohortes={cohortes} />
      </ChartCard>
    </Bloque>
  );
}

function TablaCohortes({ cohortes }: { cohortes: CohorteRetencion[] }) {
  const { salvia, coral } = useChartColors();
  const conAltas = cohortes.some((c) => c.tamano > 0);
  if (!conAltas) {
    return <EmptyChart mensaje="Sin altas en los últimos 6 meses." />;
  }

  const th: React.CSSProperties = {
    textAlign: 'right',
    padding: '8px 10px',
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--sala-text-tertiary)',
    whiteSpace: 'nowrap'
  };
  const td: React.CSSProperties = {
    textAlign: 'right',
    padding: '10px',
    fontSize: '14px',
    fontVariantNumeric: 'tabular-nums',
    borderTop: '1px solid var(--sala-border)'
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '420px' }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }}>Cohorte</th>
            <th style={th}>Miembros</th>
            <th style={th}>+1 mes</th>
            <th style={th}>+2 meses</th>
            <th style={th}>+3 meses</th>
          </tr>
        </thead>
        <tbody>
          {cohortes.map((c) => (
            <tr key={c.mes}>
              <td
                style={{
                  ...td,
                  textAlign: 'left',
                  fontWeight: 600,
                  textTransform: 'capitalize',
                  color: 'var(--sala-text-primary)'
                }}
              >
                {c.label}
              </td>
              <td style={{ ...td, color: 'var(--sala-text-secondary)' }}>
                {c.tamano || '—'}
              </td>
              {c.retencion.map((pct, i) => (
                <td
                  key={i}
                  style={{
                    ...td,
                    fontWeight: 600,
                    color: pct == null ? 'var(--sala-text-tertiary)' : colorRetencion(pct, { salvia, coral })
                  }}
                >
                  {pct == null ? '—' : `${pct}%`}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function colorRetencion(pct: number, colors: { salvia: string; coral: string }): string {
  if (pct >= 70) return colors.salvia;
  if (pct >= 40) return 'var(--sala-text-primary)';
  return colors.coral;
}

function BloqueMiembrosRiesgo({ miembros }: { miembros: MiembroRiesgo[] }) {
  const { coral } = useChartColors();
  return (
    <Bloque titulo={`Miembros en riesgo (${miembros.length})`}>
      <div
        style={{
          background: 'var(--sala-surface)',
          border: '1px solid var(--sala-border)',
          borderRadius: '14px',
          padding: '18px'
        }}
      >
        <p
          style={{
            fontSize: '12px',
            fontWeight: 600,
            color: 'var(--sala-text-secondary)',
            margin: '0 0 14px'
          }}
        >
          Activos sin reservar ni asistir hace 21+ días — contactalos antes de perderlos.
        </p>
        {miembros.length === 0 ? (
          <EmptyChart mensaje="Nadie en riesgo. Todos los miembros activos reservaron hace poco." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {miembros.map((m) => (
              <div
                key={m.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  padding: '10px 14px',
                  background: 'var(--sala-bg)',
                  border: '1px solid var(--sala-border)',
                  borderRadius: '12px'
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <p
                    style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      color: 'var(--sala-text-primary)',
                      margin: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {m.nombre}
                  </p>
                  <p
                    style={{
                      fontSize: '12px',
                      color: 'var(--sala-text-tertiary)',
                      margin: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {m.email}
                  </p>
                </div>
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: '12px',
                    fontWeight: 600,
                    color: coral,
                    fontVariantNumeric: 'tabular-nums'
                  }}
                >
                  {m.diasSinActividad == null
                    ? 'Sin actividad reciente'
                    : `${m.diasSinActividad} días`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Bloque>
  );
}

// ============================================================================
// Primitivas de UI reutilizables
// ============================================================================

function Bloque({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section>
      <h2
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '18px',
          fontWeight: 600,
          letterSpacing: '-0.02em',
          color: 'var(--sala-text-primary)',
          margin: '0 0 14px'
        }}
      >
        {titulo}
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>{children}</div>
    </section>
  );
}

function KpiRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '12px'
      }}
    >
      {children}
    </div>
  );
}

interface CompararKpi {
  actual: number;
  anterior: number | null;
  /** true cuando subir es MALO (churn, no-shows, canceladas). */
  inversa?: boolean;
  /** 'relativo' = % de cambio (conteos); 'puntos' = diferencia (porcentajes). */
  modo?: 'relativo' | 'puntos';
}

function KpiCard({
  label,
  valor,
  alerta,
  nota,
  comparar
}: {
  label: string;
  valor: string | number;
  alerta?: boolean;
  nota?: string;
  comparar?: CompararKpi;
}) {
  const { coral } = useChartColors();
  return (
    <div
      style={{
        background: 'var(--sala-surface)',
        border: `1px solid ${alerta ? 'var(--sala-error-glow)' : 'var(--sala-border)'}`,
        borderRadius: '14px',
        padding: '16px 18px'
      }}
    >
      <p
        style={{
          fontSize: '11px',
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--sala-text-tertiary)',
          margin: '0 0 8px'
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
          fontVariantNumeric: 'tabular-nums',
          color: alerta ? coral : 'var(--sala-text-primary)',
          margin: 0
        }}
      >
        {valor}
      </p>
      {comparar && <DeltaBadge {...comparar} />}
      {nota && (
        <p style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)', margin: '4px 0 0' }}>
          {nota}
        </p>
      )}
    </div>
  );
}

/** Indicador de variación vs. el período anterior. */
function DeltaBadge({ actual, anterior, inversa = false, modo = 'relativo' }: CompararKpi) {
  const { salvia, coral } = useChartColors();
  if (anterior == null) return null;

  let texto: string;
  let subio: boolean;

  if (modo === 'puntos') {
    const d = Math.round((actual - anterior) * 10) / 10;
    if (d === 0) return <DeltaIgual />;
    subio = d > 0;
    texto = `${Math.abs(d)} pts`;
  } else {
    if (anterior === 0) {
      if (actual === 0) return <DeltaIgual />;
      subio = true;
      texto = 'nuevo';
    } else {
      const pct = ((actual - anterior) / anterior) * 100;
      if (Math.round(pct) === 0) return <DeltaIgual />;
      subio = pct > 0;
      texto = `${Math.abs(Math.round(pct))}%`;
    }
  }

  const esBueno = inversa ? !subio : subio;
  const Flecha = subio ? ArrowUp : ArrowDown;
  return (
    <p style={{ fontSize: '11px', fontWeight: 600, margin: '4px 0 0' }}>
      <span style={{ color: esBueno ? salvia : coral, display: 'inline-flex', alignItems: 'center', gap: '2px', verticalAlign: 'middle' }}>
        <Flecha size={12} strokeWidth={2.5} />
        {texto}
      </span>{' '}
      <span style={{ color: 'var(--sala-text-tertiary)', fontWeight: 500 }}>vs. anterior</span>
    </p>
  );
}

function DeltaIgual() {
  return (
    <p
      style={{
        fontSize: '11px',
        fontWeight: 500,
        color: 'var(--sala-text-tertiary)',
        margin: '4px 0 0',
        display: 'flex',
        alignItems: 'center',
        gap: '3px'
      }}
    >
      <Minus size={12} strokeWidth={2.5} />
      sin cambios vs. anterior
    </p>
  );
}

function ChartCard({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderRadius: '14px',
        padding: '18px'
      }}
    >
      <p
        style={{
          fontSize: '12px',
          fontWeight: 600,
          color: 'var(--sala-text-secondary)',
          margin: '0 0 14px'
        }}
      >
        {titulo}
      </p>
      {children}
    </div>
  );
}

function EmptyChart({ mensaje }: { mensaje: string }) {
  return (
    <div
      style={{
        minHeight: '120px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--sala-text-tertiary)',
        fontSize: '13px',
        textAlign: 'center',
        padding: '0 16px'
      }}
    >
      {mensaje}
    </div>
  );
}
