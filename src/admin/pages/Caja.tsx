import { useEffect, useMemo, useState } from 'react';
import { Banknote, CreditCard, ArrowLeftRight, Gift, Globe, Undo2 } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { translateActionError } from '@reception/lib/traducirErrorAccion';
import { useSucursal } from '../providers/SucursalProvider';

/**
 * CAJA — el dinero que entró de verdad.
 *
 * Hasta ahora un cobro en efectivo no dejaba ningún rastro del monto (solo una
 * línea de bitácora con texto libre), así que el gym no tenía forma de cuadrar
 * la caja. Ahora `pagos` registra cada cobro (plan, paquete, inscripción) con su
 * método y quién lo cobró; esta pantalla lo lee.
 *
 * El ledger es append-only: un cobro no se edita ni se borra. Devolver dinero no
 * es corregir el cobro, es asentar un REEMBOLSO: una fila nueva, negativa, que
 * apunta al cobro que revierte. El original queda intacto y auditable, y la caja
 * lo resta sola.
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
  revierte_pago_id: string | null;
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
  reembolso: 'Reembolso',
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
  const toast = useToast();
  const { sucursalFiltro, sucursalActiva } = useSucursal();
  const [rango, setRango] = useState<Rango>('hoy');
  const [pagos, setPagos] = useState<PagoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [devolviendo, setDevolviendo] = useState<PagoRow | null>(null);
  const [reload, setReload] = useState(0);

  // sucursalFiltro es null en "Todas las sedes" o en un gym de una sola sede:
  // ahí no filtramos (y así no perdemos los cobros online, que llegan sin sede).
  const filtrarSede = !!sucursalFiltro;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      let q = supabase
        .from('pagos')
        .select(
          'id, created_at, concepto, monto_centavos, moneda, metodo, notas, revierte_pago_id, socio:usuarios!pagos_usuario_id_fkey(nombre), cobrador:usuarios!pagos_cobrado_por_fkey(nombre), tier:tiers(nombre)'
        )
        .eq('tenant_id', tenant.id)
        .gte('created_at', desdeISO(rango))
        .order('created_at', { ascending: false });
      if (sucursalFiltro) q = q.eq('sucursal_id', sucursalFiltro);
      const { data, error } = await q;
      if (cancelled) return;
      if (error) console.error('[Caja]', error);
      setPagos((data ?? []) as unknown as PagoRow[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tenant.id, rango, reload, sucursalFiltro]);

  // Totales por método. La cortesía NO suma: es dinero que no entró. Los
  // reembolsos son negativos, así que restan solos — sin ninguna cuenta especial.
  const totales = useMemo(() => {
    const porMetodo: Record<string, number> = {};
    let cobrado = 0;
    let devuelto = 0;
    for (const p of pagos) {
      porMetodo[p.metodo] = (porMetodo[p.metodo] ?? 0) + p.monto_centavos;
      if (p.metodo !== 'cortesia') cobrado += p.monto_centavos;
      if (p.concepto === 'reembolso') devuelto += -p.monto_centavos;
    }
    return { porMetodo, cobrado, devuelto };
  }, [pagos]);

  // Cuánto se devolvió ya de cada cobro, para no ofrecer devolver de más. Solo
  // cuenta lo del periodo cargado; el tope REAL lo pone la RPC, que mira todo.
  const devueltoPorPago = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pagos) {
      if (p.revierte_pago_id) {
        m.set(p.revierte_pago_id, (m.get(p.revierte_pago_id) ?? 0) + -p.monto_centavos);
      }
    }
    return m;
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
      <p style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: filtrarSede ? '8px' : '20px' }}>
        El dinero que entró de verdad: cobros de mostrador y online.
      </p>
      {filtrarSede && (
        <p style={{ fontSize: '12.5px', color: 'var(--ek-ink-faint)', margin: '0 0 20px' }}>
          Mostrando los cobros de <strong>{sucursalActiva?.nombre}</strong>, la sede elegida arriba.
        </p>
      )}

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
        {/* El total es NETO. Si hubo devoluciones hay que decirlo, o el dueño ve un
            número más chico del que esperaba y no sabe por qué. */}
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: '0 0 18px' }}>
          {pagos.length} {pagos.length === 1 ? 'movimiento' : 'movimientos'} · las cortesías no suman (no entró dinero).
          {totales.devuelto > 0 && (
            <>
              {' · '}
              <span style={{ color: 'var(--sala-error)' }}>
                {money(totales.devuelto, moneda)} devueltos, ya descontados
              </span>
            </>
          )}
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
            const esReembolso = p.concepto === 'reembolso';
            const Icon = esReembolso ? Undo2 : meta.Icon;
            const esCortesia = p.metodo === 'cortesia';
            // Devolver tiene sentido solo sobre un COBRO que movió dinero y del
            // que quede algo sin devolver.
            const yaDevuelto = devueltoPorPago.get(p.id) ?? 0;
            const puedeDevolver =
              !esReembolso && !esCortesia && p.monto_centavos - yaDevuelto > 0;
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
                    background: esReembolso ? 'var(--sala-error-light, var(--sala-surface))' : 'var(--sala-primary-light)',
                    color: esReembolso ? 'var(--sala-error)' : 'var(--sala-primary)'
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
                    {p.cobrador?.nombre
                      ? ` · ${esReembolso ? 'devolvió' : 'cobró'} ${p.cobrador.nombre}`
                      : ''}
                  </p>
                  {esReembolso && p.notas && (
                    <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--sala-text-secondary)' }}>
                      {p.notas}
                    </p>
                  )}
                  {!esReembolso && yaDevuelto > 0 && (
                    <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--sala-error)' }}>
                      Devuelto: {money(yaDevuelto, p.moneda)}
                    </p>
                  )}
                </div>

                {puedeDevolver && (
                  <button
                    type="button"
                    onClick={() => setDevolviendo(p)}
                    className="ek-cta ek-cta--secondary"
                    style={{ minHeight: '32px', padding: '0 12px', fontSize: '12px', flexShrink: 0 }}
                  >
                    Devolver
                  </button>
                )}

                <p
                  style={{
                    margin: 0,
                    fontWeight: 700,
                    fontSize: '15px',
                    whiteSpace: 'nowrap',
                    color: esReembolso
                      ? 'var(--sala-error)'
                      : esCortesia
                        ? 'var(--sala-text-tertiary)'
                        : 'var(--sala-text-primary)',
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

      {devolviendo && (
        <DevolverModal
          pago={devolviendo}
          yaDevuelto={devueltoPorPago.get(devolviendo.id) ?? 0}
          onClose={() => setDevolviendo(null)}
          onHecho={(msg) => {
            setDevolviendo(null);
            toast.success(msg);
            setReload((n) => n + 1);
          }}
          onError={(msg) => toast.error(msg)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Devolver dinero
// ============================================================================

function DevolverModal({
  pago,
  yaDevuelto,
  onClose,
  onHecho,
  onError
}: {
  pago: PagoRow;
  yaDevuelto: number;
  onClose: () => void;
  onHecho: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const disponible = pago.monto_centavos - yaDevuelto;
  const [monto, setMonto] = useState(String(Math.round(disponible / 100)));
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const montoCentavos = Math.round(Number(monto) * 100);
  const montoValido =
    Number.isFinite(montoCentavos) && montoCentavos > 0 && montoCentavos <= disponible;
  const motivoValido = motivo.trim().length >= 3;

  async function devolver() {
    setEnviando(true);
    const { data, error } = await supabase.rpc('registrar_reembolso' as never, {
      p_pago_id: pago.id,
      p_monto_centavos: montoCentavos,
      p_motivo: motivo.trim()
    } as never);

    if (error) {
      setEnviando(false);
      onError(translateActionError(error.message));
      return;
    }

    const res = data as { requiere_accion_en_stripe?: boolean } | null;
    onHecho(
      res?.requiere_accion_en_stripe
        ? 'Reembolso registrado. Ojo: el dinero se devuelve desde Stripe.'
        : 'Reembolso registrado.'
    );
  }

  return (
    <div className="ek-modal-backdrop" onClick={onClose}>
      <div className="ek-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '420px' }}>
        <div className="ek-modal-handle" />
        <h3 className="ek-h3" style={{ marginBottom: '4px' }}>Devolver dinero</h3>
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '0 0 20px', lineHeight: 1.5 }}>
          {pago.socio?.nombre ?? 'El socio'} · {CONCEPTO_LABEL[pago.concepto] ?? pago.concepto}
          {' · '}{money(pago.monto_centavos, pago.moneda)}
          {yaDevuelto > 0 && ` (ya se devolvieron ${money(yaDevuelto, pago.moneda)})`}
        </p>

        {pago.metodo === 'stripe' && (
          <p style={{
            fontSize: '12px',
            lineHeight: 1.5,
            padding: '10px 12px',
            marginBottom: '16px',
            borderRadius: 'var(--ek-r-card)',
            background: 'var(--sala-surface)',
            color: 'var(--sala-text-secondary)'
          }}>
            Este cobro fue online. Esto lo <strong>asienta en la caja</strong>, pero el dinero se
            devuelve desde Stripe: hacelo también allá.
          </p>
        )}

        <div className="ek-form-field">
          <label className="ek-label">Monto a devolver</label>
          <input
            type="number"
            value={monto}
            onChange={(e) => setMonto(e.target.value)}
            className="ek-input"
            min={1}
            max={Math.round(disponible / 100)}
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Se puede devolver hasta {money(disponible, pago.moneda)}. Podés devolver una parte.
          </p>
        </div>

        <div className="ek-form-field" style={{ marginTop: '12px' }}>
          <label className="ek-label">Motivo</label>
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            className="ek-input"
            placeholder="Cobro duplicado, el socio se arrepintió…"
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Obligatorio: sin motivo, el movimiento no se puede auditar después.
          </p>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '16px 0 0', lineHeight: 1.5 }}>
          El cobro original no se toca: queda registrado, y este reembolso se asienta aparte.
          Tampoco se da de baja el plan — eso se hace desde la ficha del socio.
        </p>

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button type="button" onClick={onClose} className="ek-cta ek-cta--secondary" style={{ flex: 1 }}>
            Cancelar
          </button>
          <button
            type="button"
            onClick={devolver}
            disabled={!montoValido || !motivoValido || enviando}
            className="ek-cta"
            style={{ flex: 1 }}
          >
            {enviando ? 'Devolviendo…' : 'Devolver'}
          </button>
        </div>
      </div>
    </div>
  );
}
