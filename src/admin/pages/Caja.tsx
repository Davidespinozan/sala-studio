import { useEffect, useMemo, useRef, useState } from 'react';
import { Banknote, CreditCard, ArrowLeftRight, Gift, Globe, Undo2, Receipt } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { translateActionError } from '@reception/lib/traducirErrorAccion';
import { useSucursal } from '../providers/SucursalProvider';
import { exportarCsv } from '@shared/lib/exportarCsv';
import { ReciboModal } from '@shared/components/ReciboModal';
import { CorteTicket, CortePrint, type CorteTicketData } from '@shared/components/CorteTicket';
import { imprimirCorte, compartirCorteImagen } from '@shared/lib/recibo';

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

interface ResumenCorte {
  total_centavos: number;
  por_concepto: { label: string; centavos: number }[];
  por_metodo: { label: string; centavos: number }[];
}
interface CorteRow {
  id: string;
  desde: string | null;
  hasta: string;
  efectivo_esperado_centavos: number;
  fondo_centavos: number;
  efectivo_contado_centavos: number;
  diferencia_centavos: number;
  notas: string | null;
  resumen: ResumenCorte | null;
  realizado_por: { nombre: string | null } | null;
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
  producto: 'Producto',
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

/** Fecha local (del dispositivo = horario del gym) como YYYY-MM-DD. */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
/** Rango [desde, hasta) en horario LOCAL: incluye todo el día `fHasta`. */
function rangoISO(fDesde: string, fHasta: string): { desde: string; hasta: string } {
  const desde = new Date(`${fDesde}T00:00:00`);
  const hasta = new Date(`${fHasta}T00:00:00`);
  hasta.setDate(hasta.getDate() + 1);
  return { desde: desde.toISOString(), hasta: hasta.toISOString() };
}

interface DatosCorte { razon_social?: string; rfc?: string; telefono?: string; direccion?: string }

export default function Caja() {
  const tenant = useTenant();
  const { usuario } = useAuth();
  const toast = useToast();
  const { sucursalFiltro, sucursalActiva } = useSucursal();
  const [ticketData, setTicketData] = useState<CorteTicketData | null>(null);
  const corteRef = useRef<HTMLDivElement>(null);
  const [compartiendoCorte, setCompartiendoCorte] = useState(false);
  const [showDatos, setShowDatos] = useState(false);
  const [datosCorte, setDatosCorte] = useState<DatosCorte>(() => ((tenant.config as unknown as { corte?: DatosCorte })?.corte ?? {}));
  const [rango, setRango] = useState<Rango>('hoy');
  const [pagos, setPagos] = useState<PagoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [devolviendo, setDevolviendo] = useState<PagoRow | null>(null);
  const [reciboId, setReciboId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [showCorte, setShowCorte] = useState(false);
  const [cortes, setCortes] = useState<CorteRow[]>([]);
  const [cortesReload, setCortesReload] = useState(0);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const { data } = await (supabase as any)
        .from('cortes_caja')
        .select('id, desde, hasta, efectivo_esperado_centavos, fondo_centavos, efectivo_contado_centavos, diferencia_centavos, notas, resumen, realizado_por:usuarios!cortes_caja_realizado_por_fkey(nombre)')
        .eq('tenant_id', tenant.id)
        .order('hasta', { ascending: false })
        .limit(8);
      if (!cancel) setCortes((data ?? []) as CorteRow[]);
    })();
    return () => { cancel = true; };
  }, [tenant.id, cortesReload]);

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

  function gymHeaderData() {
    const footerDir = (tenant.config as unknown as { landing?: { footer?: { direccion?: string } } })?.landing?.footer?.direccion ?? null;
    return {
      nombre: (datosCorte.razon_social || '').trim() || tenant.nombre || 'Gimnasio',
      direccion: (datosCorte.direccion || '').trim() || footerDir,
      rfc: (datosCorte.rfc || '').trim() || null,
      telefono: (datosCorte.telefono || '').trim() || null
    };
  }

  async function desgloseDePeriodo(desde: string | null, hasta: string) {
    let q = supabase.from('pagos').select('concepto, metodo, monto_centavos').eq('tenant_id', tenant.id).lt('created_at', hasta);
    if (desde) q = q.gte('created_at', desde);
    if (sucursalFiltro) q = q.eq('sucursal_id', sucursalFiltro);
    const { data } = await q;
    const rows = ((data ?? []) as unknown as { concepto: string; metodo: string; monto_centavos: number }[]).filter((r) => r.metodo !== 'cortesia');
    const total = rows.reduce((s, r) => s + r.monto_centavos, 0);
    const concMap: Record<string, number> = {};
    const metMap: Record<string, number> = {};
    const metLabel: Record<string, string> = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', stripe: 'Online' };
    for (const r of rows) {
      const cl = r.concepto === 'plan' || r.concepto === 'inscripcion' ? 'Membresías'
        : r.concepto === 'paquete' ? 'Paquetes'
          : r.concepto === 'producto' ? 'Productos'
            : r.concepto === 'reembolso' ? 'Devoluciones' : 'Otros';
      concMap[cl] = (concMap[cl] ?? 0) + r.monto_centavos;
      metMap[r.metodo] = (metMap[r.metodo] ?? 0) + r.monto_centavos;
    }
    const ordenC = ['Membresías', 'Paquetes', 'Productos', 'Otros', 'Devoluciones'];
    const porConcepto = ordenC.filter((l) => concMap[l] !== undefined).map((l) => ({ label: l, centavos: concMap[l] }));
    const porMetodo = Object.entries(metMap).map(([k, v]) => ({ label: metLabel[k] ?? k, centavos: v }));
    return { porConcepto, total, porMetodo };
  }

  async function mostrarTicket(c: {
    desde: string | null; hasta: string;
    efectivo_esperado_centavos: number; fondo_centavos: number;
    efectivo_contado_centavos: number; diferencia_centavos: number; recepcion: string | null;
    resumen?: ResumenCorte | null;
  }) {
    // Corte histórico (importado): usa el snapshot guardado. Corte normal: recalcula.
    const { porConcepto, total, porMetodo } = c.resumen
      ? { porConcepto: c.resumen.por_concepto, total: c.resumen.total_centavos, porMetodo: c.resumen.por_metodo }
      : await desgloseDePeriodo(c.desde, c.hasta);
    setTicketData({
      gym: gymHeaderData(),
      sucursalNombre: sucursalActiva?.nombre ?? null,
      recepcion: c.recepcion,
      desde: c.desde, hasta: c.hasta,
      porConcepto, totalCentavos: total, porMetodo, moneda,
      efectivoEsperadoCentavos: c.efectivo_esperado_centavos, fondoCentavos: c.fondo_centavos,
      efectivoContadoCentavos: c.efectivo_contado_centavos, diferenciaCentavos: c.diferencia_centavos
    });
  }

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
        <button
          type="button"
          onClick={() => exportarCsv(`caja-${rango}`, pagos, [
            { key: 'created_at', label: 'Fecha y hora', valor: (p) => new Date(p.created_at).toLocaleString('es-MX') },
            { key: 'concepto', label: 'Concepto' },
            { key: 'socio', label: 'Socio', valor: (p) => (p as any).socio?.nombre ?? '' },
            { key: 'metodo', label: 'Método', valor: (p) => (p.metodo === 'tarjeta' ? 'Terminal' : p.metodo === 'stripe' ? 'App' : p.metodo) },
            { key: 'monto_centavos', label: 'Monto', valor: (p) => (p.monto_centavos / 100).toFixed(2) },
            { key: 'moneda', label: 'Moneda' },
            { key: 'cobrador', label: 'Cobró', valor: (p) => (p as any).cobrador?.nombre ?? '' },
            { key: 'notas', label: 'Notas' }
          ])}
          className="ek-cta ek-cta--secondary"
          style={{ marginLeft: 'auto' }}
          disabled={pagos.length === 0}
        >
          Exportar CSV
        </button>
        <button type="button" onClick={() => setShowDatos(true)} className="ek-cta ek-cta--secondary" title="Datos que salen en el ticket del corte">
          Datos del corte
        </button>
        <button type="button" onClick={() => setShowCorte(true)} className="ek-cta">
          Hacer corte
        </button>
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

                {!esReembolso && !esCortesia && (
                  <button
                    type="button"
                    onClick={() => setReciboId(p.id)}
                    className="ek-cta ek-cta--secondary"
                    title="Recibo"
                    style={{ minHeight: '32px', padding: '0 12px', fontSize: '12px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    <Receipt size={14} /> Recibo
                  </button>
                )}

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

      {reciboId && (
        <ReciboModal pagoId={reciboId} modo="staff" onClose={() => setReciboId(null)} />
      )}

      {cortes.length > 0 && (
        <section className="ek-card" style={{ padding: 0, overflow: 'hidden', marginTop: '20px' }}>
          <p className="ek-eyebrow" style={{ padding: '14px 18px 4px', margin: 0 }}>ÚLTIMOS CORTES</p>
          {cortes.map((c, i) => (
            <button
              key={c.id}
              type="button"
              onClick={() => void mostrarTicket({
                desde: c.desde, hasta: c.hasta,
                efectivo_esperado_centavos: c.efectivo_esperado_centavos, fondo_centavos: c.fondo_centavos,
                efectivo_contado_centavos: c.efectivo_contado_centavos, diferencia_centavos: c.diferencia_centavos,
                recepcion: c.realizado_por?.nombre ?? null,
                resumen: c.resumen
              })}
              style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 18px', borderTop: i === 0 ? 'none' : '0.5px solid var(--sala-border)', background: 'none', border: 'none', width: '100%', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
              title="Ver / imprimir este corte"
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--sala-text-primary)' }}>
                  {hora(c.hasta)}{c.realizado_por?.nombre ? ` · ${c.realizado_por.nombre}` : ''}
                </p>
                <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--sala-text-tertiary)' }}>
                  Esperado {money(c.efectivo_esperado_centavos + c.fondo_centavos, moneda)} · Contado {money(c.efectivo_contado_centavos, moneda)}
                </p>
              </div>
              <span style={{ fontWeight: 700, fontSize: '14px', whiteSpace: 'nowrap', color: c.diferencia_centavos === 0 ? 'var(--sala-text-secondary)' : c.diferencia_centavos > 0 ? 'var(--sala-success)' : 'var(--sala-error)' }}>
                {c.diferencia_centavos === 0 ? 'Cuadra' : (c.diferencia_centavos > 0 ? 'Sobra ' : 'Falta ') + money(Math.abs(c.diferencia_centavos), moneda)}
              </span>
            </button>
          ))}
        </section>
      )}

      {showCorte && (
        <CorteModal
          sucursalId={sucursalFiltro}
          moneda={moneda}
          onClose={() => setShowCorte(false)}
          onHecho={(r) => {
            setShowCorte(false);
            toast.success(r.diferencia_centavos === 0 ? 'Corte hecho: la caja cuadra.' : r.diferencia_centavos > 0 ? `Corte hecho: sobran ${money(Math.abs(r.diferencia_centavos), moneda)}.` : `Corte hecho: faltan ${money(Math.abs(r.diferencia_centavos), moneda)}.`);
            setCortesReload((n) => n + 1);
            setReload((n) => n + 1);
            void mostrarTicket({ ...r, recepcion: usuario?.nombre ?? 'Recepción' });
          }}
          onError={(msg) => toast.error(msg)}
        />
      )}

      {showDatos && (
        <DatosCorteModal
          tenantId={tenant.id}
          config={tenant.config as Record<string, unknown>}
          datos={datosCorte}
          onClose={() => setShowDatos(false)}
          onSaved={(d) => { setDatosCorte(d); setShowDatos(false); toast.success('Datos del corte guardados.'); }}
          onError={(m) => toast.error(m)}
        />
      )}

      {ticketData && (
        <div className="ek-modal-backdrop no-print" onClick={() => setTicketData(null)}>
          <div className="ek-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div ref={corteRef}>
              <CorteTicket data={ticketData} />
            </div>
            <CortePrint data={ticketData} />
            <div className="no-print" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                disabled={compartiendoCorte}
                onClick={async () => {
                  if (!corteRef.current) return;
                  setCompartiendoCorte(true);
                  try {
                    const r = await compartirCorteImagen(corteRef.current, ticketData.gym.nombre, ticketData.hasta);
                    if (r === 'descargado') toast.success('Imagen descargada — adjúntala en WhatsApp.');
                  } catch {
                    toast.error('No se pudo compartir el corte.');
                  } finally {
                    setCompartiendoCorte(false);
                  }
                }}
                className="ek-cta"
                style={{ width: '100%' }}
              >
                {compartiendoCorte ? 'Generando…' : 'Enviar por WhatsApp'}
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => setTicketData(null)} className="ek-cta ek-cta--secondary" style={{ flex: 1 }}>Cerrar</button>
                <button type="button" onClick={() => imprimirCorte()} className="ek-cta ek-cta--secondary" style={{ flex: 1 }}>Imprimir / PDF</button>
              </div>
            </div>
          </div>
        </div>
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
  const [tipo, setTipo] = useState<'devolucion' | 'correccion'>('devolucion');
  const [monto, setMonto] = useState(String(Math.round(disponible / 100)));
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const montoCentavos = Math.round(Number(monto) * 100);
  const montoValido =
    Number.isFinite(montoCentavos) && montoCentavos > 0 && montoCentavos <= disponible;
  const motivoValido = motivo.trim().length >= 3;
  const esCorreccion = tipo === 'correccion';

  const PRESETS = ['Cobro duplicado', 'Era cortesía (no pagó)', 'No pagó inscripción', 'Monto equivocado'];

  async function devolver() {
    setEnviando(true);
    // El motivo lleva el TIPO para que en la auditoría se distinga una corrección
    // de error de una devolución real al cliente (el efecto en la caja es el mismo:
    // una entrada que revierte el cobro).
    const motivoFinal = `${esCorreccion ? 'Corrección' : 'Devolución'}: ${motivo.trim()}`;
    const { data, error } = await supabase.rpc('registrar_reembolso' as never, {
      p_pago_id: pago.id,
      p_monto_centavos: montoCentavos,
      p_motivo: motivoFinal
    } as never);

    if (error) {
      setEnviando(false);
      onError(translateActionError(error.message));
      return;
    }

    const res = data as { requiere_accion_en_stripe?: boolean } | null;
    onHecho(
      esCorreccion
        ? 'Corrección registrada.'
        : res?.requiere_accion_en_stripe
          ? 'Devolución registrada. Ojo: el dinero se devuelve desde Stripe.'
          : 'Devolución registrada.'
    );
  }

  return (
    <div className="ek-modal-backdrop" onClick={onClose}>
      <div className="ek-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '420px' }}>
        <div className="ek-modal-handle" />
        <h3 className="ek-h3" style={{ marginBottom: '4px' }}>Devolver / Corregir</h3>
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
          {pago.socio?.nombre ?? 'El socio'} · {CONCEPTO_LABEL[pago.concepto] ?? pago.concepto}
          {' · '}{money(pago.monto_centavos, pago.moneda)}
          {yaDevuelto > 0 && ` (ya se revirtieron ${money(yaDevuelto, pago.moneda)})`}
        </p>

        {/* Tipo: devolución real vs corrección de error */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          <button type="button" onClick={() => setTipo('devolucion')} className={`ek-cta ${tipo === 'devolucion' ? '' : 'ek-cta--secondary'}`} style={{ flex: 1, minHeight: 36, fontSize: 12.5 }}>
            Devolución al cliente
          </button>
          <button type="button" onClick={() => setTipo('correccion')} className={`ek-cta ${esCorreccion ? '' : 'ek-cta--secondary'}`} style={{ flex: 1, minHeight: 36, fontSize: 12.5 }}>
            Corrección de error
          </button>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '0 0 14px', lineHeight: 1.45 }}>
          {esCorreccion
            ? 'Se registró algo por error (duplicado, cortesía, inscripción que no pagó). Lo revierte sin que aparezca como un reembolso de dinero al cliente.'
            : 'El cliente pidió su dinero de vuelta. Se asienta como devolución en la caja.'}
        </p>

        {pago.metodo === 'stripe' && !esCorreccion && (
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
            devuelve desde Stripe: hazlo también allá.
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
            Hasta {money(disponible, pago.moneda)}. Puedes revertir solo una parte.
          </p>
        </div>

        <div className="ek-form-field" style={{ marginTop: '12px' }}>
          <label className="ek-label">Motivo</label>
          {esCorreccion && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
              {PRESETS.map((p) => (
                <button key={p} type="button" onClick={() => setMotivo(p)} className="ek-cta ek-cta--secondary" style={{ minHeight: 28, padding: '0 10px', fontSize: 11.5 }}>
                  {p}
                </button>
              ))}
            </div>
          )}
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            className="ek-input"
            placeholder={esCorreccion ? 'Duplicado, era cortesía…' : 'El socio se arrepintió…'}
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Obligatorio: sin motivo, el movimiento no se puede auditar después.
          </p>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '16px 0 0', lineHeight: 1.5 }}>
          El cobro original no se toca: queda registrado, y esta reversión se asienta aparte.
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
            {enviando ? 'Guardando…' : esCorreccion ? 'Corregir' : 'Devolver'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Corte de caja
// ============================================================================

function CorteModal({
  sucursalId,
  moneda,
  onClose,
  onHecho,
  onError
}: {
  sucursalId: string | null;
  moneda: string;
  onClose: () => void;
  onHecho: (r: {
    desde: string | null; hasta: string;
    efectivo_esperado_centavos: number; fondo_centavos: number;
    efectivo_contado_centavos: number; diferencia_centavos: number;
  }) => void;
  onError: (msg: string) => void;
}) {
  const ayer = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return ymd(d); })();
  const [fDesde, setFDesde] = useState(ayer);
  const [fHasta, setFHasta] = useState(ayer);
  const [esperado, setEsperado] = useState<number | null>(null);
  const [fondo, setFondo] = useState('0');
  const [contado, setContado] = useState('');
  const [enviando, setEnviando] = useState(false);

  const rangoValido = fDesde !== '' && fHasta !== '' && fHasta >= fDesde;

  useEffect(() => {
    if (!rangoValido) { setEsperado(null); return; }
    let cancel = false;
    setEsperado(null);
    (async () => {
      const { desde, hasta } = rangoISO(fDesde, fHasta);
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        name: string,
        args: unknown
      ) => Promise<{ data: { efectivo_esperado_centavos: number } | null; error: { message: string } | null }>;
      const { data } = await rpc('preview_corte_caja', { p_desde: desde, p_hasta: hasta, p_sucursal_id: sucursalId });
      if (!cancel) setEsperado(data?.efectivo_esperado_centavos ?? 0);
    })();
    return () => { cancel = true; };
  }, [sucursalId, fDesde, fHasta, rangoValido]);

  const fondoC = Math.round(Number(fondo || '0') * 100);
  const contadoC = Math.round(Number(contado || '0') * 100);
  const espC = esperado ?? 0;
  const dif = (Number.isFinite(contadoC) ? contadoC : 0) - (espC + (Number.isFinite(fondoC) ? fondoC : 0));
  const contadoValido = contado.trim() !== '' && Number.isFinite(contadoC) && contadoC >= 0;

  async function confirmar() {
    if (!contadoValido || esperado === null || !rangoValido) return;
    setEnviando(true);
    const { desde, hasta } = rangoISO(fDesde, fHasta);
    const rpc = supabase.rpc.bind(supabase) as unknown as (
      name: string,
      args: unknown
    ) => Promise<{ data: { desde: string | null; hasta: string; efectivo_esperado_centavos: number; fondo_centavos: number; efectivo_contado_centavos: number; diferencia_centavos: number } | null; error: { message: string } | null }>;
    const { data, error } = await rpc('hacer_corte_caja', {
      p_desde: desde,
      p_hasta: hasta,
      p_sucursal_id: sucursalId,
      p_efectivo_contado_centavos: contadoC,
      p_fondo_centavos: Number.isFinite(fondoC) ? fondoC : 0,
      p_notas: null
    });
    setEnviando(false);
    if (error || !data) { onError('No se pudo hacer el corte. Intenta de nuevo.'); return; }
    onHecho(data);
  }

  function setRango(d: string, h: string) { setFDesde(d); setFHasta(h); }
  const hoy = ymd(new Date());
  const inicioSemana = (() => { const d = new Date(); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return ymd(d); })();
  const inicioMes = ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const presets = [
    { label: 'Hoy', d: hoy, h: hoy },
    { label: 'Ayer', d: ayer, h: ayer },
    { label: 'Esta semana', d: inicioSemana, h: hoy },
    { label: 'Este mes', d: inicioMes, h: hoy }
  ];

  return (
    <div className="ek-modal-backdrop" onClick={onClose}>
      <div className="ek-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '420px' }}>
        <div className="ek-modal-handle" />
        <h3 className="ek-h3" style={{ marginBottom: '4px' }}>Corte de caja</h3>
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>
          Elige el rango, cuenta el efectivo del cajón y captúralo. Lo comparamos con lo que
          registró el sistema en ese periodo. Tarjeta, transferencia y online no cuentan.
        </p>

        {/* Rango de fechas (horario del gym) — atajos + personalizado */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setRango(p.d, p.h)}
              className={`ek-cta ${fDesde === p.d && fHasta === p.h ? '' : 'ek-cta--secondary'}`}
              style={{ flex: '1 1 calc(50% - 4px)', minHeight: 34, fontSize: 12 }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '10px', marginBottom: '16px' }}>
          <label className="ek-form-field" style={{ flex: 1 }}>
            <span className="ek-label">Del día</span>
            <input type="date" className="ek-input" value={fDesde} max={fHasta || hoy} onChange={(e) => setFDesde(e.target.value)} />
          </label>
          <label className="ek-form-field" style={{ flex: 1 }}>
            <span className="ek-label">Al día</span>
            <input type="date" className="ek-input" value={fHasta} min={fDesde} onChange={(e) => setFHasta(e.target.value)} />
          </label>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13.5px', padding: '2px 0' }}>
            <span style={{ color: 'var(--sala-text-tertiary)' }}>Efectivo esperado (sistema)</span>
            <span style={{ fontWeight: 700 }}>{!rangoValido ? '—' : esperado === null ? '…' : money(espC, moneda)}</span>
          </div>
          <div className="ek-form-field">
            <label className="ek-label">Fondo inicial (opcional)</label>
            <input type="number" className="ek-input" value={fondo} min={0} onChange={(e) => setFondo(e.target.value)} />
          </div>
          <div className="ek-form-field">
            <label className="ek-label">Efectivo contado</label>
            <input type="number" className="ek-input" value={contado} min={0} placeholder="0" autoFocus onChange={(e) => setContado(e.target.value)} />
          </div>
        </div>

        {contadoValido && esperado !== null && (
          <div
            style={{
              marginTop: '14px', padding: '12px 14px', borderRadius: '12px', textAlign: 'center', fontWeight: 700,
              background: dif === 0 ? 'var(--sala-surface)' : dif > 0 ? 'var(--sala-success-bg)' : 'var(--sala-error-bg)',
              color: dif === 0 ? 'var(--sala-text-secondary)' : dif > 0 ? 'var(--sala-success)' : 'var(--sala-error)'
            }}
          >
            {dif === 0 ? 'La caja cuadra' : (dif > 0 ? 'Sobran ' : 'Faltan ') + money(Math.abs(dif), moneda)}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button type="button" onClick={onClose} disabled={enviando} className="ek-cta ek-cta--secondary" style={{ flex: 1 }}>
            Cancelar
          </button>
          <button type="button" onClick={confirmar} disabled={!contadoValido || enviando || esperado === null || !rangoValido} className="ek-cta" style={{ flex: 1 }}>
            {enviando ? 'Guardando…' : 'Confirmar corte'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Datos fiscales del corte (encabezado del ticket)
// ============================================================================

function DatosCorteModal({
  tenantId,
  config,
  datos,
  onClose,
  onSaved,
  onError
}: {
  tenantId: string;
  config: Record<string, unknown>;
  datos: DatosCorte;
  onClose: () => void;
  onSaved: (d: DatosCorte) => void;
  onError: (m: string) => void;
}) {
  const [d, setD] = useState<DatosCorte>(datos);
  const [saving, setSaving] = useState(false);

  async function guardar() {
    setSaving(true);
    const limpio: DatosCorte = {
      razon_social: d.razon_social?.trim() || undefined,
      rfc: d.rfc?.trim() || undefined,
      telefono: d.telefono?.trim() || undefined,
      direccion: d.direccion?.trim() || undefined
    };
    const next = { ...config, corte: limpio };
    const { error } = await (supabase as unknown as {
      from: (t: string) => { update: (v: unknown) => { eq: (c: string, v: string) => Promise<{ error: { message: string } | null }> } };
    }).from('tenants').update({ config: next }).eq('id', tenantId);
    setSaving(false);
    if (error) { onError('No se pudo guardar. Intenta de nuevo.'); return; }
    onSaved(limpio);
  }

  return (
    <div className="ek-modal-backdrop" onClick={onClose}>
      <div className="ek-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '420px' }}>
        <div className="ek-modal-handle" />
        <h3 className="ek-h3" style={{ marginBottom: '4px' }}>Datos del corte</h3>
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>
          Salen en el encabezado del ticket de corte. Se guardan una sola vez.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <CampoCorte label="Razón social / Nombre" v={d.razon_social ?? ''} onChange={(v) => setD({ ...d, razon_social: v })} placeholder="Si lo dejas vacío, usa el nombre del gym" />
          <CampoCorte label="RFC" v={d.rfc ?? ''} onChange={(v) => setD({ ...d, rfc: v })} />
          <CampoCorte label="Teléfono" v={d.telefono ?? ''} onChange={(v) => setD({ ...d, telefono: v })} />
          <CampoCorte label="Dirección" v={d.direccion ?? ''} onChange={(v) => setD({ ...d, direccion: v })} placeholder="Si lo dejas vacío, usa la del footer" />
        </div>
        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button type="button" onClick={onClose} disabled={saving} className="ek-cta ek-cta--secondary" style={{ flex: 1 }}>Cancelar</button>
          <button type="button" onClick={guardar} disabled={saving} className="ek-cta" style={{ flex: 1 }}>{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </div>
    </div>
  );
}

function CampoCorte({ label, v, onChange, placeholder }: { label: string; v: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="ek-form-field">
      <span className="ek-label">{label}</span>
      <input className="ek-input" value={v} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" />
    </label>
  );
}
