import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { exportarCsv } from '@shared/lib/exportarCsv';
import { useToast } from '@shared/hooks/useToast';

/* ══════════════════════════════════════════════════════════════════════════
   HISTORIAL DE VENTAS DE LA TIENDA — rastreable
   ──────────────────────────────────────────────────────────────────────────
   Qué se vendió, cuándo (fecha + hora), con qué método y A QUIÉN. Buscable por
   rango de fechas. La misma pieza en admin y en recepción (recibe la sucursal
   por prop, porque cada superficie tiene su propio contexto de sede).

   Los datos ya existen: la venta es un `pagos` (concepto 'producto') y sus
   items cuelgan de `producto_movimientos` por `pago_id`. Acá se juntan.
   ══════════════════════════════════════════════════════════════════════════ */

interface Venta {
  id: string;
  cuando: string;
  total: number;
  moneda: string;
  metodo: string;
  socio: string | null;
  items: { nombre: string; cantidad: number }[];
  cancelada: boolean;
}

const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmt = (c: number, m = 'MXN') =>
  (c / 100).toLocaleString('es-MX', { style: 'currency', currency: m, maximumFractionDigits: 0 });

export default function VentasTienda({ sucursalId }: { sucursalId: string | null }) {
  const [desde, setDesde] = useState(hoyISO());
  const [hasta, setHasta] = useState(hoyISO());
  const [ventas, setVentas] = useState<Venta[]>([]);
  const [cargando, setCargando] = useState(true);
  const toast = useToast();
  const [cancelando, setCancelando] = useState<Venta | null>(null);
  const [motivo, setMotivo] = useState('');
  const [procesando, setProcesando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    const dIni = new Date(`${desde}T00:00:00`);
    const dFin = new Date(`${hasta}T23:59:59.999`);

    // 1) Las ventas (cabecera) desde la Caja.
    let pq = (supabase as any)
      .from('pagos')
      .select('id, created_at, monto_centavos, moneda, metodo, usuario_id')
      .eq('concepto', 'producto')
      .gte('created_at', dIni.toISOString())
      .lte('created_at', dFin.toISOString())
      .order('created_at', { ascending: false });
    if (sucursalId) pq = pq.eq('sucursal_id', sucursalId);
    const { data: pagos } = await pq;
    const filas = (pagos as any[]) ?? [];

    if (filas.length === 0) { setVentas([]); setCargando(false); return; }

    const pagoIds = filas.map((p) => p.id);
    const socioIds = [...new Set(filas.map((p) => p.usuario_id).filter(Boolean))];

    // 2) Los items de cada venta.
    const { data: movs } = await (supabase as any)
      .from('producto_movimientos')
      .select('pago_id, cantidad, producto_id')
      .in('pago_id', pagoIds)
      .eq('tipo', 'venta');
    const prodIds = [...new Set(((movs as any[]) ?? []).map((m) => m.producto_id))];

    // 3) Nombres de producto y de socio.
    const { data: prods } = prodIds.length
      ? await (supabase as any).from('productos').select('id, nombre').in('id', prodIds)
      : { data: [] };
    const nombreProd: Record<string, string> = {};
    for (const p of (prods as any[]) ?? []) nombreProd[p.id] = p.nombre;

    const { data: socios } = socioIds.length
      ? await supabase.from('usuarios').select('id, nombre').in('id', socioIds as string[])
      : { data: [] };
    const nombreSocio: Record<string, string> = {};
    for (const u of (socios as any[]) ?? []) nombreSocio[u.id] = u.nombre;

    const itemsDe: Record<string, { nombre: string; cantidad: number }[]> = {};
    for (const m of (movs as any[]) ?? []) {
      (itemsDe[m.pago_id] ??= []).push({ nombre: nombreProd[m.producto_id] ?? 'Producto', cantidad: Math.abs(m.cantidad) });
    }

    // Ventas ya canceladas: existe un reembolso que las revierte.
    const { data: reemb } = await (supabase as any)
      .from('pagos')
      .select('revierte_pago_id')
      .eq('concepto', 'reembolso')
      .in('revierte_pago_id', pagoIds);
    const canceladas = new Set(((reemb as any[]) ?? []).map((r) => r.revierte_pago_id));

    setVentas(filas.map((p) => ({
      id: p.id,
      cuando: p.created_at,
      total: p.monto_centavos,
      moneda: p.moneda,
      metodo: p.metodo,
      socio: p.usuario_id ? (nombreSocio[p.usuario_id] ?? 'Socio') : null,
      items: itemsDe[p.id] ?? [],
      cancelada: canceladas.has(p.id)
    })));
    setCargando(false);
  }, [desde, hasta, sucursalId]);

  useEffect(() => { void cargar(); }, [cargar]);

  const total = useMemo(() => ventas.reduce((s, v) => s + (v.cancelada ? 0 : v.total), 0), [ventas]);
  const moneda = ventas[0]?.moneda ?? 'MXN';

  async function confirmarCancelacion() {
    if (!cancelando) return;
    if (motivo.trim().length < 3) { toast.error('Escribe un motivo (mín. 3 letras)'); return; }
    setProcesando(true);
    const { error } = await supabase.rpc('cancelar_venta_producto' as never, {
      p_pago_id: cancelando.id, p_motivo: motivo.trim()
    } as never);
    setProcesando(false);
    if (error) { toast.error('No se pudo cancelar: ' + error.message); return; }
    toast.success('Venta cancelada — se devolvió el stock y el dinero');
    setCancelando(null); setMotivo('');
    void cargar();
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <label style={{ fontSize: 12, color: 'var(--ek-ink-muted)' }}>
          Desde<br /><input type="date" className="ek-input" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--ek-ink-muted)' }}>
          Hasta<br /><input type="date" className="ek-input" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} />
        </label>
        <button
          type="button"
          onClick={() => exportarCsv(`ventas-tienda-${desde}_a_${hasta}`, ventas, [
            { key: 'cuando', label: 'Fecha y hora', valor: (v) => new Date(v.cuando).toLocaleString('es-MX') },
            { key: 'items', label: 'Qué se vendió', valor: (v) => v.items.map((it) => `${it.cantidad}× ${it.nombre}`).join(' · ') },
            { key: 'socio', label: 'A quién', valor: (v) => v.socio ?? 'Público' },
            { key: 'metodo', label: 'Método', valor: (v) => (v.metodo === 'tarjeta' ? 'Terminal' : v.metodo === 'stripe' ? 'App' : v.metodo) },
            { key: 'total', label: 'Total', valor: (v) => (v.total / 100).toFixed(2) },
            { key: 'moneda', label: 'Moneda' }
          ])}
          className="ek-cta ek-cta--secondary"
          disabled={ventas.length === 0}
        >
          Exportar CSV
        </button>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ek-ink-faint)' }}>Total del período</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{fmt(total, moneda)} <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ek-ink-faint)' }}>· {ventas.length} ventas</span></div>
        </div>
      </div>

      {cargando ? (
        <p className="ek-body-muted">Cargando…</p>
      ) : ventas.length === 0 ? (
        <div className="ek-card" style={{ padding: 28, textAlign: 'center' }}>
          <p className="ek-body-muted" style={{ margin: 0 }}>No hay ventas en esas fechas.</p>
        </div>
      ) : (
        <div className="ek-card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
            <thead>
              <tr>{['Fecha y hora', 'Qué se vendió', 'A quién', 'Método', 'Total', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {ventas.map((v) => (
                <tr key={v.id} style={{ opacity: v.cancelada ? 0.55 : 1 }}>
                  <td style={{ ...td, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                    {new Date(v.cuando).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td style={td}>{v.items.map((it) => `${it.cantidad}× ${it.nombre}`).join(', ') || '—'}</td>
                  <td style={{ ...td, color: v.socio ? 'var(--ek-ink)' : 'var(--ek-ink-faint)' }}>{v.socio ?? 'Público'}</td>
                  <td style={{ ...td, textTransform: 'capitalize' }}>{v.metodo === 'tarjeta' ? 'Terminal' : v.metodo === 'stripe' ? 'App' : v.metodo}</td>
                  <td style={{ ...td, fontWeight: 700, fontVariantNumeric: 'tabular-nums', textDecoration: v.cancelada ? 'line-through' : 'none' }}>{fmt(v.total, v.moneda)}</td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {v.cancelada
                      ? <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ek-danger)' }}>Cancelada</span>
                      : <button className="ek-cta ek-cta--secondary" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => { setCancelando(v); setMotivo(''); }}>Cancelar</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cancelando && (
        <div onClick={() => !procesando && setCancelando(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} className="ek-card" style={{ maxWidth: 420, width: '100%', padding: 20 }}>
            <h3 className="ek-h3" style={{ marginTop: 0 }}>Cancelar venta</h3>
            <p className="ek-body-muted" style={{ fontSize: 13, marginTop: 0 }}>
              Se devuelve el stock ({cancelando.items.map((it) => `${it.cantidad}× ${it.nombre}`).join(', ') || '—'}) y se reversa {fmt(cancelando.total, cancelando.moneda)} en la Caja.
            </p>
            <label style={{ fontSize: 12, color: 'var(--ek-ink-muted)' }}>Motivo</label>
            <textarea className="ek-input" rows={2} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej. producto equivocado / el cliente se arrepintió" style={{ width: '100%', resize: 'vertical', display: 'block', marginTop: 4 }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button className="ek-cta ek-cta--secondary" style={{ flex: 1 }} disabled={procesando} onClick={() => setCancelando(null)}>Volver</button>
              <button className="ek-cta" style={{ flex: 1 }} disabled={procesando} onClick={() => void confirmarCancelacion()}>{procesando ? 'Cancelando…' : 'Cancelar venta'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ek-ink-faint)', padding: '10px 14px', borderBottom: '1px solid var(--ek-line)' };
const td: React.CSSProperties = { padding: '11px 14px', borderBottom: '1px solid var(--ek-line)' };
