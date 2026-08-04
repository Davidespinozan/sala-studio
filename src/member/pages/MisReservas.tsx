import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, QrCode } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { supabase } from '@shared/lib/supabase';
import type { Database } from '@shared/types/database';
import { getTenantTimezone, formatHoraEnTz } from '@shared/lib/timezone';

type Reserva = Database['public']['Tables']['reservas']['Row'];
type Recurso = Database['public']['Tables']['recursos']['Row'];

interface ReservaConRecurso extends Reserva {
  recurso: Pick<Recurso, 'nombre'> | null;
}

type Tab = 'proximas' | 'historial';

/**
 * Trae las reservas del socio partidas en dos: PRÓXIMAS (confirmadas a futuro,
 * ascendente — la más cercana primero) e HISTORIAL (completadas / canceladas /
 * no-show ya pasadas, descendente). Datos del propio socio → nada en admin.
 */
function useMisReservas(usuarioId: string | undefined) {
  const [proximas, setProximas] = useState<ReservaConRecurso[]>([]);
  const [historial, setHistorial] = useState<ReservaConRecurso[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!usuarioId) return;
    let mounted = true;
    async function load() {
      const nowIso = new Date().toISOString();
      const [px, hist] = await Promise.all([
        supabase
          .from('reservas')
          .select('*, recurso:recursos(nombre)')
          .eq('usuario_id', usuarioId!)
          .eq('status', 'confirmada')
          .gte('slot_inicio', nowIso)
          .order('slot_inicio', { ascending: true }),
        supabase
          .from('reservas')
          .select('*, recurso:recursos(nombre)')
          .eq('usuario_id', usuarioId!)
          .in('status', ['completada', 'cancelada', 'no_show'])
          .lt('slot_inicio', nowIso)
          .order('slot_inicio', { ascending: false })
          .limit(40)
      ]);
      if (!mounted) return;
      setProximas((px.data ?? []) as unknown as ReservaConRecurso[]);
      setHistorial((hist.data ?? []) as unknown as ReservaConRecurso[]);
      setLoading(false);
    }
    void load();
    return () => {
      mounted = false;
    };
  }, [usuarioId]);

  return { proximas, historial, loading };
}

/** Agrupa reservas (ya ordenadas) por día en la tz del gym, conservando el orden. */
function agruparPorDia(
  reservas: ReservaConRecurso[],
  tz: string
): { label: string; items: ReservaConRecurso[] }[] {
  const groups: { label: string; items: ReservaConRecurso[] }[] = [];
  for (const r of reservas) {
    const label = new Date(r.slot_inicio).toLocaleDateString('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: tz
    });
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(r);
    else groups.push({ label, items: [r] });
  }
  return groups;
}

export default function MisReservas() {
  const { usuario } = useAuth();
  const tenant = useTenant();
  const tz = getTenantTimezone(tenant);
  const { proximas, historial, loading } = useMisReservas(usuario?.id);
  const [tab, setTab] = useState<Tab>('proximas');

  const visibles = tab === 'proximas' ? proximas : historial;
  const grupos = useMemo(() => agruparPorDia(visibles, tz), [visibles, tz]);

  return (
    <div className="ek-container" style={{ paddingTop: '12px' }}>
      <Link
        to="/app"
        className="adm-link"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', marginBottom: '16px' }}
      >
        <ArrowLeft size={15} strokeWidth={2.25} />
        Inicio
      </Link>

      <p className="ek-eyebrow" style={{ marginBottom: '8px' }}>TU AGENDA</p>
      <h1 className="ek-display-xl" style={{ marginBottom: '20px' }}>Mis reservas</h1>

      {/* Tabs Próximas / Historial */}
      <div
        style={{
          display: 'flex',
          gap: '6px',
          padding: '4px',
          background: 'var(--sala-surface)',
          border: '1px solid var(--sala-border)',
          borderRadius: '999px',
          marginBottom: '24px'
        }}
      >
        <TabButton
          active={tab === 'proximas'}
          onClick={() => setTab('proximas')}
          label="Próximas"
          count={proximas.length}
        />
        <TabButton
          active={tab === 'historial'}
          onClick={() => setTab('historial')}
          label="Historial"
          count={historial.length}
        />
      </div>

      {loading ? (
        <div className="ek-stack-sm">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                height: '64px',
                background: 'var(--sala-surface)',
                border: '1px solid var(--sala-border)',
                borderRadius: 'var(--ek-r-card)'
              }}
            />
          ))}
        </div>
      ) : visibles.length === 0 ? (
        <EmptyState tab={tab} />
      ) : (
        <div className="ek-stack-xl">
          {grupos.map((g) => (
            <section key={g.label}>
              <p
                className="ek-eyebrow"
                style={{ marginBottom: '10px', color: 'var(--sala-text-tertiary)' }}
              >
                {g.label}
              </p>
              <div className="ek-stack-sm">
                {g.items.map((r) => (
                  <ReservaRow key={r.id} r={r} tz={tz} esProxima={tab === 'proximas'} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        minHeight: '44px',
        border: 'none',
        cursor: 'pointer',
        borderRadius: '999px',
        fontSize: '13px',
        fontWeight: 600,
        background: active ? 'var(--sala-primary)' : 'transparent',
        color: active ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)',
        transition: 'background 0.15s ease'
      }}
    >
      {label}
      {count > 0 && <span style={{ opacity: 0.7 }}> · {count}</span>}
    </button>
  );
}

function ReservaRow({
  r,
  tz,
  esProxima
}: {
  r: ReservaConRecurso;
  tz: string;
  esProxima: boolean;
}) {
  const nombre = r.recurso?.nombre ?? 'Sala';
  const hora = formatHoraEnTz(new Date(r.slot_inicio), tz);

  const cuerpo = (
    <>
      <div style={{ minWidth: 0, flex: 1 }}>
        <p
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '15px',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            margin: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {nombre}
        </p>
        <p className="ek-body-faint" style={{ marginTop: '2px', fontVariantNumeric: 'tabular-nums' }}>
          {hora} hs
        </p>
      </div>
      {esProxima ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 14px',
            borderRadius: '999px',
            background: 'var(--grad-accent)',
            color: 'var(--sala-text-on-accent)',
            border: '1px solid var(--sala-accent)',
            fontSize: '12px',
            fontWeight: 600,
            boxShadow: '0 4px 12px var(--sala-accent-dim)'
          }}
        >
          <QrCode size={14} strokeWidth={2.25} />
          Mi QR
        </span>
      ) : (
        <span
          className={
            r.status === 'completada'
              ? 'ek-badge ek-badge--success'
              : r.status === 'cancelada'
                ? 'ek-badge ek-badge--neutral'
                : 'ek-badge ek-badge--danger'
          }
        >
          {r.status === 'completada' ? 'OK' : r.status === 'cancelada' ? 'CANCELADA' : 'NO SHOW'}
        </span>
      )}
    </>
  );

  const cardStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px'
  };

  // Una reserva próxima abre su QR de acceso; el historial no es accionable.
  if (esProxima) {
    return (
      <Link to={`/app/qr/${r.id}`} className="ek-card ek-card--md ek-lift" style={{ ...cardStyle, textDecoration: 'none' }}>
        {cuerpo}
      </Link>
    );
  }
  return (
    <div className="ek-card ek-card--md" style={cardStyle}>
      {cuerpo}
    </div>
  );
}

function EmptyState({ tab }: { tab: Tab }) {
  if (tab === 'proximas') {
    return (
      <div className="ek-card ek-card--md" style={{ textAlign: 'center', padding: '32px 20px' }}>
        <p className="ek-body-muted" style={{ marginBottom: '16px' }}>
          No tienes reservas próximas.
        </p>
        <Link to="/app/reservar" className="ek-cta">
          Reservar una clase
          <ChevronRight size={16} strokeWidth={2.25} />
        </Link>
      </div>
    );
  }
  return (
    <div className="ek-card ek-card--md" style={{ textAlign: 'center', padding: '32px 20px' }}>
      <p className="ek-body-muted">Todavía no tienes historial de reservas.</p>
    </div>
  );
}
