import { useState } from 'react';
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

const SALVIA = '#3d6b52';
const SALVIA_LIGHT = '#a9c4b3';
const CORAL = '#c44a35';

export default function Reportes() {
  const [periodo, setPeriodo] = useState<PeriodoReporte>('mes');
  const { data, isLoading } = useReportes(periodo);

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
    </div>
  );
}

// ============================================================================
// Bloques
// ============================================================================

function BloqueOcupacion({ data }: { data: ReportesData }) {
  const o = data.ocupacion;
  return (
    <Bloque titulo="Ocupación y asistencia">
      <KpiRow>
        <KpiCard label="Ocupación promedio" valor={`${o.promedioPct}%`} />
        <KpiCard label="Clases en el período" valor={o.totalClases} />
        <KpiCard
          label="Asistencia"
          valor={o.asistenciaPct == null ? '—' : `${o.asistenciaPct}%`}
        />
        <KpiCard label="No-shows" valor={o.noShows} alerta={o.noShows > 5} />
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
              <Bar dataKey="ocupacionPct" name="Ocupación" radius={[6, 6, 0, 0]} fill={SALVIA} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </Bloque>
  );
}

function BloqueMiembros({ data }: { data: ReportesData }) {
  const m = data.miembros;
  return (
    <Bloque titulo="Miembros">
      <KpiRow>
        <KpiCard label="Miembros activos" valor={m.activos} />
        <KpiCard label="Altas nuevas" valor={m.altasNuevas} />
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
              <Bar dataKey="cantidad" name="Miembros" radius={[6, 6, 0, 0]} fill={SALVIA} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </Bloque>
  );
}

function BloqueReservas({ data }: { data: ReportesData }) {
  const r = data.reservas;
  return (
    <Bloque titulo="Reservas">
      <KpiRow>
        <KpiCard label="Total de reservas" valor={r.total} />
        <KpiCard label="Confirmadas" valor={r.confirmadas} />
        <KpiCard label="Canceladas" valor={r.canceladas} />
        <KpiCard label="Promedio por día" valor={r.promedioPorDia} />
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
                  <Cell key={d.fecha} fill={d.cantidad > 0 ? SALVIA : SALVIA_LIGHT} />
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

function KpiCard({
  label,
  valor,
  alerta
}: {
  label: string;
  valor: string | number;
  alerta?: boolean;
}) {
  return (
    <div
      style={{
        background: 'var(--sala-surface)',
        border: `1px solid ${alerta ? 'rgba(196, 74, 53, 0.35)' : 'var(--sala-border)'}`,
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
          color: alerta ? CORAL : 'var(--sala-text-primary)',
          margin: 0
        }}
      >
        {valor}
      </p>
    </div>
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
        height: '180px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--sala-text-tertiary)',
        fontSize: '13px'
      }}
    >
      {mensaje}
    </div>
  );
}
