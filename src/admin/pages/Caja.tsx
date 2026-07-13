import { useEffect, useMemo, useState } from 'react';
import { Banknote, CreditCard, ArrowLeftRight, Gift, Globe } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';

/**
 * CAJA — el dinero que entró de verdad.
 *
 * Hasta ahora un cobro en efectivo no dejaba ningún rastro del monto (solo una
 * línea de bitácora con texto libre), así que el gym no tenía forma de cuadrar
 * la caja. Ahora `pagos` registra cada cobro (plan, paquete, inscripción) con su
 * método y quién lo cobró; esta pantalla lo lee.
 *
 * Es SOLO LECTURA: los pagos son un ledger append-only (no se editan ni se
 * borran; una corrección es otro asiento).
 */

type Metodo = 'efectivo' | 'tarjeta' | 'transferencia' | 'stripe' | 'cortesia';

interface PagoRow {
  id: string;
  created_at: string;
  concepto: string;
  monto_centavos: number;
  moneda: string;
  metodo: Metodo;
  notas: string | null;
  socio: { nombre: string | null } | null;
  cobrador: { nombre: string | null } | null;
  tier: { nombre: string | null } | null;
}

const METODO_META: Record<Metodo, { label: string; Icon: typeof Banknote }> = {
  efectivo: { label: 'Efectivo', Icon: Banknote },
  tarjeta: { label: 'Tarjeta', Icon: CreditCard },
  transferencia: { label: 'Transferencia', Icon: ArrowLeftRight },
  stripe: { label: 'Online', Icon: Globe },
  cortesia: { label: 'Cortesía', Icon: Gift }
};

const CONCEPTO_LABEL: Record<string, string> = {
  plan: 'Plan',
  paquete: 'Paquete',
  inscripcion: 'Inscripción',
  otro: 'Otro'
};

type Rango = 'hoy' | 'semana' | 'mes';

const RANGOS: { value: Rango; label: string }[] = [
  { value: 'hoy', label: 'Hoy' },
  { value: 'semana', label: 'Últimos 7 días' },
  { value: 'mes', label: 'Este mes' }
];

function desdeISO(rango: Rango): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (rango === 'semana') d.setDate(d.getDate() - 6);
  if (rango === 'mes') d.setDate(1);
  return d.toISOString();
}

function money(centavos: number, moneda = 'MXN'): string {
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: (moneda || 'MXN').toUpperCase(),
      maximumFractionDigits: 0
    }).format(centavos / 100);
  } catch {
    return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
  }
}

function hora(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export default function Caja() {
  const tenant = useTenant();
  const [rango, setRango] = useState<Rango>('hoy');
  const [pagos, setPagos] = useState<PagoRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('pagos')
        .select(
          'id, created_at, concepto, monto_centavos, moneda, metodo, notas, socio:usuarios!pagos_usuario_id_fkey(nombre), cobrador:usuarios!pagos_cobrado_por_fkey(nombre), tier:tiers(nombre)'
        )
        .eq('tenant_id', tenant.id)
        .gte('created_at', desdeISO(rango))
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (error) console.error('[Caja]', error);
      setPagos((data ?? []) as unknown as PagoRow[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tenant.id, rango]);

  // Totales por método. La cortesía NO suma: es dinero que no entró.
  const totales = useMemo(() => {
    const porMetodo: Record<string, number> = {};
    let cobrado = 0;
    for (const p of pagos) {
      porMetodo[p.metodo] = (porMetodo[p.metodo] ?? 0) + p.monto_centavos;
      if (p.metodo !== 'cortesia') cobrado += p.monto_centavos;
    }
    return { porMetodo, cobrado };
  }, [pagos]);

  const moneda = pagos[0]?.moneda ?? 'MXN';

  return (
    <div className="adm-page">
      <p className="ek-eyebrow" style={{ marginBottom: '4px' }}>OPERACIÓN</p>
      <h1
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(28px, 5vw, 40px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          margin: 0,
          marginBottom: '6px'
        }}
      >
        Caja
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '20px' }}>
        El dinero que entró de verdad: cobros de mostrador y online.
      </p>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '20px' }}>
        {RANGOS.map((r) => {
          const active = rango === r.value;
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => setRango(r.value)}
              style={{
                padding: '8px 16px',
                borderRadius: '999px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
                background: active ? 'var(--grad-primary)' : 'var(--sala-surface)',
                color: active ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)',
                border: `1px solid ${active ? 'var(--sala-primary)' : 'var(--sala-border)'}`
              }}
            >
              {r.label}
            </button>
          );
        })}
      </div>

      {/* Corte: total cobrado + desglose por método */}
      <section
        className="ek-card"
        style={{ padding: '22px', marginBottom: '20px', display: 'block' }}
      >
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ fontSize: '11px', marginBottom: '6px' }}>
          TOTAL COBRADO
        </p>
        <p
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '38px',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            margin: '0 0 4px',
            color: 'var(--sala-text-primary)'
          }}
        >
          {money(totales.cobrado, moneda)}
        </p>
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: '0 0 18px' }}>
          {pagos.length} {pagos.length === 1 ? 'cobro' : 'cobros'} · las cortesías no suman (no entró dinero).
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
          {(Object.keys(METODO_META) as Metodo[]).map((m) => {
            const { label, Icon } = METODO_META[m];
            const total = totales.porMetodo[m] ?? 0;
            if (total === 0) return null;
            return (
              <div
                key={m}
                style={{
                  padding: '12px 14px',
                  borderRadius: '10px',
                  background: 'var(--sala-primary-light)',
                  border: '0.5px solid var(--sala-border)'
                }}
              >
                <p style={{ display: 'flex', alignItems: 'center', gap: '6px', margin: '0 0 4px', fontSize: '12px', color: 'var(--sala-text-secondary)', fontWeight: 600 }}>
                  <Icon size={14} strokeWidth={2.25} />
                  {label}
                </p>
                <p style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: 'var(--sala-text-primary)' }}>
                  {money(total, moneda)}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Detalle */}
      {loading ? (
        <div className="ek-skeleton" style={{ height: '220px', borderRadius: '12px' }} />
      ) : pagos.length === 0 ? (
        <div className="ek-card" style={{ padding: '32px', textAlign: 'center' }}>
          <p style={{ margin: 0, fontWeight: 700 }}>Todavía no hay cobros en este periodo</p>
          <p style={{ margin: '6px 0 0', fontSize: '13px', color: 'var(--sala-text-secondary)', lineHeight: 1.5 }}>
            Los cobros aparecen acá cuando recepción asigna, renueva o cambia un plan eligiendo un
            método de pago, y también cuando un socio paga online.
          </p>
        </div>
      ) : (
        <div className="ek-card" style={{ padding: 0, overflow: 'hidden' }}>
          {pagos.map((p, i) => {
            const meta = METODO_META[p.metodo] ?? METODO_META.efectivo;
            const Icon = meta.Icon;
            const esCortesia = p.metodo === 'cortesia';
            return (
              <div
                key={p.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '14px 18px',
                  borderTop: i === 0 ? 'none' : '0.5px solid var(--sala-border)'
                }}
              >
                <span
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: '50%',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    background: 'var(--sala-primary-light)',
                    color: 'var(--sala-primary)'
                  }}
                >
                  <Icon size={16} strokeWidth={2.25} />
                </span>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: '14px', color: 'var(--sala-text-primary)' }}>
                    {p.socio?.nombre ?? 'Socio'}
                    <span style={{ color: 'var(--sala-text-tertiary)', fontWeight: 500 }}>
                      {' · '}{CONCEPTO_LABEL[p.concepto] ?? p.concepto}
                      {p.tier?.nombre ? ` ${p.tier.nombre}` : ''}
                    </span>
                  </p>
                  <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--sala-text-tertiary)' }}>
                    {hora(p.created_at)} · {meta.label}
                    {p.cobrador?.nombre ? ` · cobró ${p.cobrador.nombre}` : ''}
                  </p>
                </div>

                <p
                  style={{
                    margin: 0,
                    fontWeight: 700,
                    fontSize: '15px',
                    whiteSpace: 'nowrap',
                    color: esCortesia ? 'var(--sala-text-tertiary)' : 'var(--sala-text-primary)',
                    textDecoration: esCortesia ? 'line-through' : 'none'
                  }}
                >
                  {money(p.monto_centavos, p.moneda)}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
