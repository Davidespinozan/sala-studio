import { useEffect, useMemo, useRef, useState } from 'react';
import { Banknote, CreditCard, ArrowLeftRight, Gift, Globe, Undo2, Receipt, Pencil } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { translateActionError } from '@reception/lib/traducirErrorAccion';
import { useSucursal } from '../providers/SucursalProvider';
import { exportarCsv } from '@shared/lib/exportarCsv';
import { ReciboModal } from '@shared/components/ReciboModal';
import { CorteTicket, CortePrint, type CorteTicketData } from '@shared/components/CorteTicket';
import CardMenuDropdown, { type DropdownItem } from '../components/CardMenuDropdown';
import { PorCobrarCard } from '../components/PorCobrarCard';
import { useTenantConfigEditor } from '../hooks/useTenantConfigEditor';
import { imprimirCorte, compartirCorteImagen, conceptoLabel } from '@shared/lib/recibo';
import { getTenantTimezone, hoyEnTimezone, sumarDias } from '@shared/lib/timezone';
import { fromZonedTime } from 'date-fns-tz';

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

type Rango = 'hoy' | 'ayer' | 'semana' | 'mes';

const RANGOS: { value: Rango; label: string }[] = [
  { value: 'hoy', label: 'Hoy' },
  { value: 'ayer', label: 'Ayer' },
  { value: 'semana', label: 'Últimos 7 días' },
  { value: 'mes', label: 'Este mes' }
];

// El "día" es el del GYM (tenant.config.timezone), no el del dispositivo. Sin esto,
// abrir Caja desde otra zona (o UTC) corría las fechas ~horas y metía cobros de la
// noche anterior en "Hoy". Se calcula la medianoche del gym y se pasa a instante UTC.
function desdeISO(rango: Rango, tz: string): string {
  const hoy = hoyEnTimezone(tz);
  let fecha = hoy;
  if (rango === 'ayer') fecha = sumarDias(hoy, -1);
  else if (rango === 'semana') fecha = sumarDias(hoy, -6);
  else if (rango === 'mes') fecha = `${hoy.slice(0, 8)}01`;
  return fromZonedTime(`${fecha}T00:00:00`, tz).toISOString();
}

/** Límite superior (exclusivo). Solo "Ayer" lo necesita: corta en la medianoche
 *  de HOY del gym, para no arrastrar los movimientos de hoy. */
function hastaISO(rango: Rango, tz: string): string | null {
  if (rango !== 'ayer') return null;
  return fromZonedTime(`${hoyEnTimezone(tz)}T00:00:00`, tz).toISOString();
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

function hora(iso: string, tz: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz
  });
}

/**
 * Etiqueta humana del PERIODO de un corte. El límite superior es exclusivo
 * (medianoche del día siguiente), así que mostrar `hasta` tal cual engañaba:
 * un corte del día 3 se pintaba "4 ago, 12:00 a.m." y parecían cortes de otro
 * día (E: "hay 4 cortes del 4 de agosto" — eran del 3).
 */
function etiquetaCorte(desde: string | null, hasta: string, tz: string): string {
  const dia = (iso: string) =>
    new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', timeZone: tz });
  // Último instante DENTRO del periodo (hasta es exclusivo).
  const finDia = dia(new Date(Date.parse(hasta) - 1000).toISOString());
  if (!desde) return `Corte al ${finDia}`;
  const inicioDia = dia(desde);
  return inicioDia === finDia ? `Corte del ${inicioDia}` : `Corte del ${inicioDia} al ${finDia}`;
}

/** Rango [desde, hasta) en la timezone del GYM: incluye todo el día `fHasta`. */
function rangoISO(fDesde: string, fHasta: string, tz: string): { desde: string; hasta: string } {
  return {
    desde: fromZonedTime(`${fDesde}T00:00:00`, tz).toISOString(),
    hasta: fromZonedTime(`${sumarDias(fHasta, 1)}T00:00:00`, tz).toISOString()
  };
}

interface DatosCorte { razon_social?: string; rfc?: string; telefono?: string; direccion?: string }

export default function Caja() {
  const tenant = useTenant();
  const { usuario } = useAuth();
  const toast = useToast();
  const { sucursalFiltro, sucursalActiva } = useSucursal();
  const tz = getTenantTimezone(tenant);
  // Corte sin arqueo (config.caja.corte_simple, por tenant — lo pidió numa):
  // el corte solo asienta el desglose de lo cobrado; sin fondo inicial, sin
  // contar efectivo y sin sobra/falta. El resto de los gyms no cambia.
  const corteSimple = (tenant.config as { caja?: { corte_simple?: boolean } } | null)?.caja?.corte_simple === true;
  const [ticketData, setTicketData] = useState<CorteTicketData | null>(null);
  const corteRef = useRef<HTMLDivElement>(null);
  const [compartiendoCorte, setCompartiendoCorte] = useState(false);
  const [showDatos, setShowDatos] = useState(false);
  const [datosCorte, setDatosCorte] = useState<DatosCorte>(() => ((tenant.config as unknown as { corte?: DatosCorte })?.corte ?? {}));
  const [rango, setRango] = useState<Rango>('hoy');
  const [pagos, setPagos] = useState<PagoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [devolviendo, setDevolviendo] = useState<PagoRow | null>(null);
  const [corrigiendoMetodo, setCorrigiendoMetodo] = useState<PagoRow | null>(null);
  const [reciboId, setReciboId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [showCorte, setShowCorte] = useState(false);
  const [cortes, setCortes] = useState<CorteRow[]>([]);
  const [cortesReload, setCortesReload] = useState(0);
  // "Últimos cortes" muestra 8 y crece por tandas con "Ver más" (un gym con un
  // año de operación acumula cientos; no se cargan todos de golpe).
  const [cortesLimit, setCortesLimit] = useState(8);
  const [hayMasCortes, setHayMasCortes] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const { data } = await (supabase as any)
        .from('cortes_caja')
        .select('id, desde, hasta, efectivo_esperado_centavos, fondo_centavos, efectivo_contado_centavos, diferencia_centavos, notas, resumen, realizado_por:usuarios!cortes_caja_realizado_por_fkey(nombre)')
        .eq('tenant_id', tenant.id)
        .order('hasta', { ascending: false })
        .limit(cortesLimit + 1); // uno extra: solo para saber si hay más
      if (cancel) return;
      const rows = (data ?? []) as CorteRow[];
      setHayMasCortes(rows.length > cortesLimit);
      setCortes(rows.slice(0, cortesLimit));
    })();
    return () => { cancel = true; };
  }, [tenant.id, cortesReload, cortesLimit]);

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
        .gte('created_at', desdeISO(rango, tz))
        .order('created_at', { ascending: false });
      const hasta = hastaISO(rango, tz);
      if (hasta) q = q.lt('created_at', hasta);
      if (sucursalFiltro) q = q.eq('sucursal_id', sucursalFiltro);
      const { data, error } = await q;
      if (cancelled) return;
      if (error) console.error('[Caja]', error);
      setPagos((data ?? []) as unknown as PagoRow[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tenant.id, rango, reload, sucursalFiltro, tz]);

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
      tz,
      porConcepto, totalCentavos: total, porMetodo, moneda,
      // Corte simple: sin cuadre en el ticket (CorteTicket lo omite si contado es null).
      efectivoEsperadoCentavos: corteSimple ? null : c.efectivo_esperado_centavos,
      fondoCentavos: corteSimple ? null : c.fondo_centavos,
      efectivoContadoCentavos: corteSimple ? null : c.efectivo_contado_centavos,
      diferenciaCentavos: corteSimple ? null : c.diferencia_centavos
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

      <PorCobrarCard tenantId={tenant.id} onCambio={() => setReload((r) => r + 1)} />

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
            // Corregir método: solo pagos de dinero de mostrador (efectivo/tarjeta/
            // transferencia). No aplica a reembolsos, cortesías ni cobros online (stripe).
            const puedeCorregirMetodo =
              !esReembolso && (p.metodo === 'efectivo' || p.metodo === 'tarjeta' || p.metodo === 'transferencia');
            // En móvil estas acciones se muestran en un kebab (mismo array).
            const acciones: DropdownItem[] = [];
            if (!esReembolso && !esCortesia) acciones.push({ label: 'Recibo', icon: <Receipt size={16} strokeWidth={2.25} />, onClick: () => setReciboId(p.id) });
            if (puedeCorregirMetodo) acciones.push({ label: 'Corregir método', icon: <Pencil size={16} strokeWidth={2.25} />, onClick: () => setCorrigiendoMetodo(p) });
            if (puedeDevolver) acciones.push({ label: 'Devolver', icon: <Undo2 size={16} strokeWidth={2.25} />, onClick: () => setDevolviendo(p), danger: true });
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
                      {' · '}{conceptoLabel(p.concepto, p.tier?.nombre)}
                    </span>
                  </p>
                  <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--sala-text-tertiary)' }}>
                    {hora(p.created_at, tz)} · {meta.label}
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

                <div className="caja-row-actions" style={{ flexShrink: 0, gap: 8 }}>
                  {!esReembolso && !esCortesia && (
                    <button
                      type="button"
                      onClick={() => setReciboId(p.id)}
                      className="ek-cta ek-cta--secondary"
                      title="Recibo"
                      style={{ minHeight: '36px', padding: '0 12px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                      <Receipt size={14} /> Recibo
                    </button>
                  )}
                  {puedeCorregirMetodo && (
                    <button
                      type="button"
                      onClick={() => setCorrigiendoMetodo(p)}
                      className="ek-cta ek-cta--secondary"
                      title="Corregir el método sin mover el dinero"
                      style={{ minHeight: '36px', padding: '0 12px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                      <Pencil size={14} /> Método
                    </button>
                  )}
                  {puedeDevolver && (
                    <button
                      type="button"
                      onClick={() => setDevolviendo(p)}
                      className="ek-cta ek-cta--secondary"
                      style={{ minHeight: '36px', padding: '0 12px', fontSize: '12px' }}
                    >
                      Devolver
                    </button>
                  )}
                </div>
                {acciones.length > 0 && (
                  <div className="caja-row-kebab" style={{ flexShrink: 0 }}>
                    <CardMenuDropdown items={acciones} />
                  </div>
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

      {corrigiendoMetodo && (
        <CorregirMetodoModal
          pago={corrigiendoMetodo}
          onClose={() => setCorrigiendoMetodo(null)}
          onHecho={(msg) => {
            setCorrigiendoMetodo(null);
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
                  {etiquetaCorte(c.desde, c.hasta, tz)}{c.realizado_por?.nombre ? ` · ${c.realizado_por.nombre}` : ''}
                </p>
                {!corteSimple && (
                  <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--sala-text-tertiary)' }}>
                    Esperado {money(c.efectivo_esperado_centavos + c.fondo_centavos, moneda)} · Contado {money(c.efectivo_contado_centavos, moneda)}
                  </p>
                )}
              </div>
              {corteSimple ? (
                c.resumen?.total_centavos != null && (
                  <span style={{ fontWeight: 700, fontSize: '14px', whiteSpace: 'nowrap', color: 'var(--sala-text-secondary)' }}>
                    {money(c.resumen.total_centavos, moneda)}
                  </span>
                )
              ) : (
                <span style={{ fontWeight: 700, fontSize: '14px', whiteSpace: 'nowrap', color: c.diferencia_centavos === 0 ? 'var(--sala-text-secondary)' : c.diferencia_centavos > 0 ? 'var(--sala-success)' : 'var(--sala-error)' }}>
                  {c.diferencia_centavos === 0 ? 'Cuadra' : (c.diferencia_centavos > 0 ? 'Sobra ' : 'Falta ') + money(Math.abs(c.diferencia_centavos), moneda)}
                </span>
              )}
            </button>
          ))}
          {hayMasCortes && (
            <button
              type="button"
              onClick={() => setCortesLimit((n) => n + 30)}
              style={{
                width: '100%',
                padding: '12px 18px',
                border: 'none',
                borderTop: '0.5px solid var(--sala-border)',
                background: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--sala-primary)'
              }}
            >
              Ver más cortes
            </button>
          )}
        </section>
      )}

      {showCorte && (
        <CorteModal
          sucursalId={sucursalFiltro}
          moneda={moneda}
          tz={tz}
          simple={corteSimple}
          cortesPrevios={cortes}
          onClose={() => setShowCorte(false)}
          onHecho={(r) => {
            setShowCorte(false);
            toast.success(corteSimple ? 'Corte hecho.' : r.diferencia_centavos === 0 ? 'Corte hecho: la caja cuadra.' : r.diferencia_centavos > 0 ? `Corte hecho: sobran ${money(Math.abs(r.diferencia_centavos), moneda)}.` : `Corte hecho: faltan ${money(Math.abs(r.diferencia_centavos), moneda)}.`);
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

/**
 * Corregir el MÉTODO de un pago (efectivo/terminal/transferencia) sin mover el dinero.
 * Para cuando recepción anotó mal cómo entró un cobro. Cambia solo la clasificación y
 * el corte lo refleja; el monto y todo lo demás quedan intactos (RPC corregir_metodo_pago).
 */
function CorregirMetodoModal({
  pago,
  onClose,
  onHecho,
  onError
}: {
  pago: PagoRow;
  onClose: () => void;
  onHecho: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const OPCIONES: { value: 'efectivo' | 'tarjeta' | 'transferencia'; label: string }[] = [
    { value: 'efectivo', label: 'Efectivo' },
    { value: 'tarjeta', label: 'Terminal (tarjeta)' },
    { value: 'transferencia', label: 'Transferencia' }
  ];
  const [metodo, setMetodo] = useState<'efectivo' | 'tarjeta' | 'transferencia'>(
    pago.metodo as 'efectivo' | 'tarjeta' | 'transferencia'
  );
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const cambiado = metodo !== pago.metodo;

  async function guardar() {
    setEnviando(true);
    const { error } = await supabase.rpc('corregir_metodo_pago' as never, {
      p_pago_id: pago.id,
      p_metodo: metodo,
      p_motivo: motivo.trim() || null
    } as never);
    if (error) {
      setEnviando(false);
      onError(translateActionError(error.message));
      return;
    }
    onHecho('Método corregido.');
  }

  return (
    <div className="ek-modal-backdrop" onClick={onClose}>
      <div className="ek-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '420px' }}>
        <div className="ek-modal-handle" />
        <h3 className="ek-h3" style={{ marginBottom: '4px' }}>Corregir método</h3>
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '0 0 6px', lineHeight: 1.5 }}>
          {pago.socio?.nombre ?? 'El socio'} · {CONCEPTO_LABEL[pago.concepto] ?? pago.concepto}
          {' · '}{money(pago.monto_centavos, pago.moneda)}
        </p>
        <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '0 0 14px', lineHeight: 1.45 }}>
          Cambia solo <strong>cómo entró el dinero</strong> (el monto no se toca). Corrige el corte sin devolver ni recobrar.
        </p>

        <label className="ek-label" htmlFor="corregir-metodo-select">Método real</label>
        <select
          id="corregir-metodo-select"
          value={metodo}
          onChange={(e) => setMetodo(e.target.value as 'efectivo' | 'tarjeta' | 'transferencia')}
          className="ek-input"
          style={{ marginBottom: '12px' }}
        >
          {OPCIONES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}{o.value === pago.metodo ? ' (actual)' : ''}
            </option>
          ))}
        </select>

        <label className="ek-label" htmlFor="corregir-metodo-motivo">Motivo (opcional)</label>
        <input
          id="corregir-metodo-motivo"
          type="text"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Ej. fue con terminal"
          className="ek-input"
          style={{ marginBottom: '16px' }}
        />

        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" onClick={onClose} className="ek-cta ek-cta--secondary" style={{ flex: 1 }} disabled={enviando}>
            Cancelar
          </button>
          <button type="button" onClick={guardar} className="ek-cta" style={{ flex: 1 }} disabled={enviando || !cambiado}>
            {enviando ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}

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
  // Un producto se DEVUELVE completo (cancela la venta): reversa dinero Y regresa
  // el stock vía cancelar_venta_producto. Sin esto, devolver un producto desde la
  // Caja dejaba el inventario inflado y bloqueaba la cancelación de la Tienda.
  const esProducto = pago.concepto === 'producto';
  const [tipo, setTipo] = useState<'devolucion' | 'correccion' | 'cortesia'>('devolucion');
  const [monto, setMonto] = useState(String(Math.round(disponible / 100)));
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const montoCentavos = Math.round(Number(monto) * 100);
  const montoValido =
    Number.isFinite(montoCentavos) && montoCentavos > 0 && montoCentavos <= disponible;
  const motivoValido = motivo.trim().length >= 3;
  const esCorreccion = tipo === 'correccion';
  const esCortesiaTipo = tipo === 'cortesia';

  const PRESETS = ['Cobro duplicado', 'Era cortesía (no pagó)', 'No pagó inscripción', 'Monto equivocado'];

  async function devolver() {
    setEnviando(true);

    // Producto: se cancela la venta completa (dinero + stock) con la RPC que
    // mantiene el inventario en sincronía.
    if (esProducto) {
      const { error } = await supabase.rpc('cancelar_venta_producto' as never, {
        p_pago_id: pago.id,
        p_motivo: motivo.trim()
      } as never);
      if (error) {
        setEnviando(false);
        onError(translateActionError(error.message));
        return;
      }
      onHecho('Venta cancelada — se devolvió el stock y el dinero.');
      return;
    }

    // "Fue cortesía": reembolsa el cobro Y lo asienta como cortesía (cuenta en el
    // total de cortesías, ingreso neto 0). Una sola operación atómica en el RPC.
    if (esCortesiaTipo) {
      const { error } = await supabase.rpc('reembolsar_como_cortesia' as never, {
        p_pago_id: pago.id,
        p_monto_centavos: montoCentavos,
        p_motivo: motivo.trim()
      } as never);
      if (error) {
        setEnviando(false);
        onError(translateActionError(error.message));
        return;
      }
      onHecho('Devuelto y registrado como cortesía.');
      return;
    }

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

        {esProducto ? (
          <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '0 0 14px', lineHeight: 1.45 }}>
            Se <strong>cancela la venta completa</strong>: se devuelve el stock a la Tienda y se reversa el dinero en la Caja.
          </p>
        ) : (
          <>
            {/* Tipo: devolución al cliente · corrección de error · fue cortesía */}
            <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
              <button type="button" onClick={() => setTipo('devolucion')} className={`ek-cta ${tipo === 'devolucion' ? '' : 'ek-cta--secondary'}`} style={{ flex: 1, minHeight: 36, fontSize: 12 }}>
                Devolución
              </button>
              <button type="button" onClick={() => setTipo('correccion')} className={`ek-cta ${esCorreccion ? '' : 'ek-cta--secondary'}`} style={{ flex: 1, minHeight: 36, fontSize: 12 }}>
                Corrección
              </button>
              <button type="button" onClick={() => setTipo('cortesia')} className={`ek-cta ${esCortesiaTipo ? '' : 'ek-cta--secondary'}`} style={{ flex: 1, minHeight: 36, fontSize: 12 }}>
                Fue cortesía
              </button>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '0 0 14px', lineHeight: 1.45 }}>
              {esCortesiaTipo
                ? 'Se cobró pero en realidad fue cortesía. Se reembolsa el cobro y se registra como cortesía: cuenta en el total de cortesías, y el ingreso real queda en 0.'
                : esCorreccion
                  ? 'Se registró algo por error (duplicado, inscripción que no pagó). Lo revierte sin que aparezca como un reembolso de dinero al cliente.'
                  : 'El cliente pidió su dinero de vuelta. Se asienta como devolución en la caja.'}
            </p>
          </>
        )}

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

        {!esProducto && (
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
        )}

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
            disabled={(esProducto ? !motivoValido : (!montoValido || !motivoValido)) || enviando}
            className="ek-cta"
            style={{ flex: 1 }}
          >
            {enviando ? 'Guardando…' : esProducto ? 'Cancelar venta' : esCorreccion ? 'Corregir' : 'Devolver'}
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
  tz,
  simple,
  cortesPrevios,
  onClose,
  onHecho,
  onError
}: {
  sucursalId: string | null;
  moneda: string;
  tz: string;
  /** Corte sin arqueo (config.caja.corte_simple): solo rango + confirmar. */
  simple: boolean;
  cortesPrevios: { desde: string | null; hasta: string }[];
  onClose: () => void;
  onHecho: (r: {
    desde: string | null; hasta: string;
    efectivo_esperado_centavos: number; fondo_centavos: number;
    efectivo_contado_centavos: number; diferencia_centavos: number;
  }) => void;
  onError: (msg: string) => void;
}) {
  const ayer = sumarDias(hoyEnTimezone(tz), -1);
  const [fDesde, setFDesde] = useState(ayer);
  const [fHasta, setFHasta] = useState(ayer);
  const [esperado, setEsperado] = useState<number | null>(null);
  const [fondo, setFondo] = useState('0');
  const [contado, setContado] = useState('');
  const [enviando, setEnviando] = useState(false);

  // Cortes por TURNO: la hora de cambio de turno la define el gym (config.caja).
  const { config: cfgTenant, saveTopLevel } = useTenantConfigEditor();
  const horaGuardada =
    (cfgTenant?.caja as { turno_corte_hora?: string } | undefined)?.turno_corte_hora ?? '14:00';
  const [horaTurno, setHoraTurno] = useState(horaGuardada);
  useEffect(() => { setHoraTurno(horaGuardada); }, [horaGuardada]);
  const [turno, setTurno] = useState<'matutino' | 'vespertino' | null>(null);
  // "Ahora" del corte vespertino se congela al elegir el turno (no cada render).
  const [turnoHasta, setTurnoHasta] = useState<string | null>(null);

  // Rango EFECTIVO: por turno (instantes con hora del gym) o por fechas (día completo).
  const { desde: desdeEf, hasta: hastaEf } = useMemo(() => {
    if (turno) {
      const hoyD = hoyEnTimezone(tz);
      const split = fromZonedTime(`${hoyD}T${horaTurno}:00`, tz).toISOString();
      return turno === 'matutino'
        ? { desde: fromZonedTime(`${hoyD}T00:00:00`, tz).toISOString(), hasta: split }
        : { desde: split, hasta: turnoHasta ?? new Date().toISOString() };
    }
    return rangoISO(fDesde, fHasta, tz);
  }, [turno, horaTurno, turnoHasta, fDesde, fHasta, tz]);

  const rangoValido = turno
    ? Date.parse(hastaEf) > Date.parse(desdeEf)
    : (fDesde !== '' && fHasta !== '' && fHasta >= fDesde);

  // Aviso (no bloquea): el rango elegido se enclima con un corte ya hecho, así que
  // los mismos cobros contarían en dos cortes. Se compara por timestamp real.
  const seEnclima = useMemo(() => {
    if (!rangoValido) return false;
    const sD = Date.parse(desdeEf);
    const sH = Date.parse(hastaEf);
    return cortesPrevios.some((c) => {
      const cD = c.desde ? Date.parse(c.desde) : -Infinity;
      return sD < Date.parse(c.hasta) && cD < sH;
    });
  }, [desdeEf, hastaEf, rangoValido, cortesPrevios]);

  useEffect(() => {
    if (!rangoValido) { setEsperado(null); return; }
    let cancel = false;
    setEsperado(null);
    (async () => {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        name: string,
        args: unknown
      ) => Promise<{ data: { efectivo_esperado_centavos: number } | null; error: { message: string } | null }>;
      const { data } = await rpc('preview_corte_caja', { p_desde: desdeEf, p_hasta: hastaEf, p_sucursal_id: sucursalId });
      if (!cancel) setEsperado(data?.efectivo_esperado_centavos ?? 0);
    })();
    return () => { cancel = true; };
  }, [sucursalId, desdeEf, hastaEf, rangoValido]);

  // Elegir un turno congela su rango; guarda la hora si numa la cambió.
  function elegirTurno(t: 'matutino' | 'vespertino') {
    setTurno(t);
    setTurnoHasta(t === 'vespertino' ? new Date().toISOString() : null);
    if (horaTurno !== horaGuardada && /^\d{2}:\d{2}$/.test(horaTurno)) {
      void saveTopLevel({ caja: { ...(cfgTenant?.caja as object ?? {}), turno_corte_hora: horaTurno } });
    }
  }

  const fondoC = Math.round(Number(fondo || '0') * 100);
  const contadoC = Math.round(Number(contado || '0') * 100);
  const espC = esperado ?? 0;
  const dif = (Number.isFinite(contadoC) ? contadoC : 0) - (espC + (Number.isFinite(fondoC) ? fondoC : 0));
  // Simple: no se captura nada — basta con que el esperado ya haya cargado.
  const contadoValido = simple || (contado.trim() !== '' && Number.isFinite(contadoC) && contadoC >= 0);

  async function confirmar() {
    if (!contadoValido || esperado === null || !rangoValido) return;
    setEnviando(true);
    const rpc = supabase.rpc.bind(supabase) as unknown as (
      name: string,
      args: unknown
    ) => Promise<{ data: { desde: string | null; hasta: string; efectivo_esperado_centavos: number; fondo_centavos: number; efectivo_contado_centavos: number; diferencia_centavos: number } | null; error: { message: string } | null }>;
    const { data, error } = await rpc('hacer_corte_caja', {
      p_desde: desdeEf,
      p_hasta: hastaEf,
      p_sucursal_id: sucursalId,
      // Simple: se asienta contado = esperado (sin fondo) → diferencia 0. El
      // ticket y la lista no muestran cuadre para este tenant de todas formas.
      p_efectivo_contado_centavos: simple ? espC : contadoC,
      p_fondo_centavos: simple ? 0 : (Number.isFinite(fondoC) ? fondoC : 0),
      p_notas: null
    });
    setEnviando(false);
    if (error || !data) { onError('No se pudo hacer el corte. Intenta de nuevo.'); return; }
    onHecho(data);
  }

  function setRango(d: string, h: string) { setTurno(null); setTurnoHasta(null); setFDesde(d); setFHasta(h); }
  const hoy = hoyEnTimezone(tz);
  const dow = (new Date(`${hoy}T00:00:00Z`).getUTCDay() + 6) % 7;
  const inicioSemana = sumarDias(hoy, -dow);
  const inicioMes = `${hoy.slice(0, 8)}01`;
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
          {simple
            ? 'Elige el rango y confirma. El corte asienta el desglose de lo cobrado en ese periodo.'
            : 'Elige el rango, cuenta el efectivo del cajón y captúralo. Lo comparamos con lo que registró el sistema en ese periodo. Tarjeta, transferencia y online no cuentan.'}
        </p>

        {/* Rango de fechas (horario del gym) — atajos + personalizado */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setRango(p.d, p.h)}
              className={`ek-cta ${!turno && fDesde === p.d && fHasta === p.h ? '' : 'ek-cta--secondary'}`}
              style={{ flex: '1 1 calc(50% - 4px)', minHeight: 34, fontSize: 12 }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Corte por turno (matutino / vespertino). La hora de cambio la define el gym. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => elegirTurno('matutino')}
            className={`ek-cta ${turno === 'matutino' ? '' : 'ek-cta--secondary'}`}
            style={{ flex: '1 1 calc(50% - 52px)', minHeight: 34, fontSize: 12 }}
          >
            Matutino
          </button>
          <button
            type="button"
            onClick={() => elegirTurno('vespertino')}
            className={`ek-cta ${turno === 'vespertino' ? '' : 'ek-cta--secondary'}`}
            style={{ flex: '1 1 calc(50% - 52px)', minHeight: 34, fontSize: 12 }}
          >
            Vespertino
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: 11, color: 'var(--sala-text-tertiary)' }}>
            corte
            <input
              type="time"
              className="ek-input"
              value={horaTurno}
              onChange={(e) => setHoraTurno(e.target.value)}
              onBlur={() => {
                if (/^\d{2}:\d{2}$/.test(horaTurno) && horaTurno !== horaGuardada) {
                  void saveTopLevel({ caja: { ...(cfgTenant?.caja as object ?? {}), turno_corte_hora: horaTurno } });
                }
              }}
              style={{ width: 90, padding: '4px 6px' }}
            />
          </label>
        </div>
        {turno && rangoValido && (
          <p style={{ fontSize: 12, color: 'var(--sala-text-secondary)', margin: '0 0 12px' }}>
            {turno === 'matutino' ? 'Turno matutino' : 'Turno vespertino'}: {hora(desdeEf, tz)} – {hora(hastaEf, tz)}
          </p>
        )}

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

        {seEnclima && (
          <div style={{ marginBottom: 16, padding: '10px 12px', borderRadius: 10, background: 'var(--sala-surface)', border: '1px solid var(--sala-border)', fontSize: 12.5, lineHeight: 1.45, color: 'var(--sala-text-secondary)' }}>
            <strong>⚠ Ojo:</strong> este rango se enclima con un corte anterior. Los mismos cobros contarían en los dos cortes. Puedes continuar, pero revisa que no estés cortando lo mismo dos veces.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13.5px', padding: '2px 0' }}>
            <span style={{ color: 'var(--sala-text-tertiary)' }}>Efectivo esperado (sistema)</span>
            <span style={{ fontWeight: 700 }}>{!rangoValido ? '—' : esperado === null ? '…' : money(espC, moneda)}</span>
          </div>
          {!simple && (
            <>
              <div className="ek-form-field">
                <label className="ek-label">Fondo inicial (opcional)</label>
                <input type="number" className="ek-input" value={fondo} min={0} onChange={(e) => setFondo(e.target.value)} />
              </div>
              <div className="ek-form-field">
                <label className="ek-label">Efectivo contado</label>
                <input type="number" className="ek-input" value={contado} min={0} placeholder="0" autoFocus onChange={(e) => setContado(e.target.value)} />
              </div>
            </>
          )}
        </div>

        {!simple && contadoValido && esperado !== null && (
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
