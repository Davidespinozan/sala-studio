import { useState } from 'react';
import { ArrowDown, ArrowUp, Minus, Info } from 'lucide-react';
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
import { useReportesEconomia, type ReportesEconomiaData } from '../hooks/useReportesEconomia';
import { useTenant } from '@shared/hooks/useTenant';

const SIMBOLO_MONEDA: Record<string, string> = { mxn: '$', usd: 'US$', eur: '€' };

/** Formatea centavos del tenant a string legible (ej. "$12,400"). */
function fmtDinero(centavos: number, moneda: string): string {
  const sym = SIMBOLO_MONEDA[moneda] ?? '$';
  return `${sym}${Math.round(centavos / 100).toLocaleString('es-MX')}`;
}

const SALA_DEFAULT_PRIMARY = '#3D6B52';
// Sin acento propio (regla: solo primario/acento), el default del acento es el
// propio primario — nunca coral. Para distinguir series, los charts usan
// salviaLight como segundo tono del mismo hue.
const SALA_DEFAULT_ACCENT  = '#3D6B52';

/** Aclara un hex mezclándolo con blanco (recharts necesita hex literal, no
 *  color-mix). amt 0..1 = cuánto blanco se mezcla. Devuelve el mismo hex si
 *  el formato no es válido. */
function lightenHex(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amt);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Hook que entrega los colores de chart para recharts.
 * Recharts no entiende CSS vars — necesita hex literal. Este hook lee
 * tenant.branding.color_primary/color_accent y devuelve hex. El segundo tono
 * (salviaLight) se DERIVA del primario del tenant (no hardcodeado), para que
 * las gráficas se tiñan con la marca de cualquier gym.
 */
function useChartColors() {
  const tenant = useTenant();
  const branding = (tenant.branding ?? {}) as Record<string, unknown>;
  const salvia = typeof branding.color_primary === 'string' ? branding.color_primary : SALA_DEFAULT_PRIMARY;
  return {
    salvia,
    coral:  typeof branding.color_accent  === 'string' ? branding.color_accent  : SALA_DEFAULT_ACCENT,
    salviaLight: lightenHex(salvia, 0.45)
  };
}

export default function Reportes() {
  const [periodo, setPeriodo] = useState<PeriodoReporte>('mes');
  const { data, isLoading } = useReportes(periodo);
  const { data: avanzado, isLoading: avLoading } = useReportesAvanzados(periodo);
  const { data: economia } = useReportesEconomia();

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
          {economia && <BloqueEconomia eco={economia} />}
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

function BloqueEconomia({ eco }: { eco: ReportesEconomiaData }) {
  const { salvia } = useChartColors();
  const m = eco.moneda;
  const datosPlan = eco.ingresoPorPlan.map((p) => ({ plan: p.plan, mrr: Math.round(p.mrrCentavos / 100) }));
  return (
    <Bloque titulo={`Economía · hoy (${m.toUpperCase()})`}>
      <KpiRow>
        <KpiCard
          label="MRR · ingreso recurrente"
          valor={fmtDinero(eco.mrrCentavos, m)}
          nota="membresías activas × precio mensual"
          ayuda="Ingreso recurrente mensual: lo que tus membresías activas facturan cada mes. Es el pulso financiero del gym. Es ingreso contratado (según el precio de cada plan), no cobro real."
        />
        <KpiCard
          label="ARR · anualizado"
          valor={fmtDinero(eco.arrCentavos, m)}
          nota="MRR × 12"
          ayuda="El MRR proyectado a un año (MRR × 12). Muestra la escala anual del negocio si todo sigue igual."
        />
        <KpiCard
          label="ARPU · por miembro"
          valor={fmtDinero(eco.arpuCentavos, m)}
          nota={`${eco.activosConPlan} miembros con plan`}
          ayuda="Ingreso promedio por socio al mes (MRR ÷ socios con plan). Si sube, tus socios están en planes más altos o subiste precios."
        />
        <KpiCard
          label="LTV estimado"
          valor={eco.ltvCentavos == null ? '—' : fmtDinero(eco.ltvCentavos, m)}
          nota={eco.churnMensualPct == null ? 'sin bajas en 90 días' : `ARPU × vida · churn ${eco.churnMensualPct}%/mes`}
          ayuda="Valor de vida del cliente: cuánto te deja un socio en total mientras dura (ARPU × vida media). Es el techo de lo que conviene gastar para captar un socio nuevo. Estimado a partir del churn."
        />
        <KpiCard
          label="Vida media del socio"
          valor={eco.lifespanMeses == null ? '—' : `${eco.lifespanMeses}${eco.lifespanTope ? '+' : ''} m`}
          nota="meses que dura un socio (estimado)"
          ayuda="Meses que dura un socio en promedio antes de darse de baja. Cuanto más alta, mejor tu retención. Se estima como 1 ÷ churn mensual."
        />
      </KpiRow>
      <ChartCard titulo="Ingreso recurrente por plan">
        {datosPlan.length === 0 ? (
          <EmptyChart mensaje="Sin membresías activas con precio todavía." />
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(160, datosPlan.length * 46)}>
            <BarChart layout="vertical" data={datosPlan} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--sala-border)" />
              <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => fmtDinero(Number(v) * 100, m)} />
              <YAxis type="category" dataKey="plan" width={96} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => fmtDinero(Number(v) * 100, m)} />
              <Bar dataKey="mrr" name="MRR" radius={[0, 6, 6, 0]} fill={salvia} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </Bloque>
  );
}

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
          ayuda="Qué tan llenas están tus clases en promedio: lugares reservados ÷ cupo. Baja ocupación = horarios o salas de más; alta sostenida = oportunidad de abrir más cupo."
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
          ayuda="De las reservas, qué porcentaje terminó asistiendo (vs. no presentarse). Mide qué tan en serio se toman los socios sus reservas."
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
          ayuda="Reservas que no se presentaron ni cancelaron a tiempo. Te queman un cupo que otro socio podría haber usado: el enemigo silencioso de la ocupación."
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
          ayuda="Porcentaje de socios activos que se dieron de baja en el período (bajas ÷ activos al inicio). Es lo opuesto a retención: cuanto más bajo, mejor. Arriba de ~10% mensual, prendé las alarmas."
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
          ayuda="De los socios que se dieron de alta hace 3 meses, qué porcentaje sigue activo hoy. Mide si tu producto engancha más allá del impulso inicial."
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
  comparar,
  ayuda
}: {
  label: string;
  valor: string | number;
  alerta?: boolean;
  nota?: string;
  comparar?: CompararKpi;
  /** Si se pasa, muestra un ícono ⓘ que abre un popover explicando qué mide. */
  ayuda?: string;
}) {
  const { coral } = useChartColors();
  return (
    <div
      style={{
        position: 'relative',
        background: 'var(--sala-surface)',
        border: `1px solid ${alerta ? 'var(--sala-error-glow)' : 'var(--sala-border)'}`,
        borderRadius: '14px',
        padding: '16px 18px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', margin: '0 0 8px' }}>
        <p
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--sala-text-tertiary)',
            margin: 0
          }}
        >
          {label}
        </p>
        {ayuda && <InfoTooltip titulo={label} texto={ayuda} />}
      </div>
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

/** Ícono ⓘ que abre un popover explicando qué mide el KPI. Click-toggle, con
 *  backdrop invisible para cerrar al tocar fuera (funciona en táctil). */
function InfoTooltip({ titulo, texto }: { titulo: string; texto: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', lineHeight: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Qué mide ${titulo}`}
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '18px',
          height: '18px',
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--sala-text-tertiary)',
          cursor: 'pointer'
        }}
      >
        <Info size={13} strokeWidth={2.25} />
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
            aria-hidden="true"
          />
          <div
            role="tooltip"
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              zIndex: 41,
              width: 'min(240px, 70vw)',
              padding: '10px 12px',
              background: 'var(--sala-surface)',
              border: '1px solid var(--sala-border)',
              borderRadius: '10px',
              boxShadow: 'var(--ek-shadow-modal, 0 12px 32px rgba(10,15,12,0.18))',
              fontSize: '12px',
              lineHeight: 1.5,
              fontWeight: 400,
              letterSpacing: 0,
              textTransform: 'none',
              color: 'var(--sala-text-secondary)',
              whiteSpace: 'normal'
            }}
          >
            {texto}
          </div>
        </>
      )}
    </span>
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
