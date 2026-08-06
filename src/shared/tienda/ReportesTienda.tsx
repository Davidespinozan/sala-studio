import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

/* ══════════════════════════════════════════════════════════════════════════
   REPORTES DE LA TIENDA — qué se vende y cuánto deja
   ──────────────────────────────────────────────────────────────────────────
   Por rango de fechas: unidades vendidas por producto (más vendidos arriba),
   ingreso y ganancia estimados al precio/costo ACTUAL. Las ventas canceladas
   (que tienen una 'devolucion') ya quedan descontadas: se cuenta el neto.
   ══════════════════════════════════════════════════════════════════════════ */

interface Fila {
  id: string;
  nombre: string;
  unidades: number;
  ingreso: number;
  ganancia: number | null; // null = el producto no tiene costo capturado
}

const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const primerDiaMes = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const fmt = (c: number, m = 'MXN') =>
  (c / 100).toLocaleString('es-MX', { style: 'currency', currency: m, maximumFractionDigits: 0 });

export default function ReportesTienda({ sucursalId }: { sucursalId: string | null }) {
  const [desde, setDesde] = useState(primerDiaMes());
  const [hasta, setHasta] = useState(hoyISO());
  const [filas, setFilas] = useState<Fila[]>([]);
  const [moneda, setMoneda] = useState('MXN');
  const [cargando, setCargando] = useState(true);

  const cargar = useCallback(async () => {
    setCargando(true);
    const dIni = new Date(`${desde}T00:00:00`);
    const dFin = new Date(`${hasta}T23:59:59.999`);

    // Catálogo (precio/costo para estimar ingreso y ganancia).
    const { data: prods } = await (supabase as any)
      .from('productos')
      .select('id, nombre, precio_centavos, costo_centavos, moneda');
    const cat: Record<string, { nombre: string; precio: number; costo: number | null }> = {};
    for (const p of (prods as any[]) ?? []) cat[p.id] = { nombre: p.nombre, precio: p.precio_centavos, costo: p.costo_centavos };
    setMoneda(((prods as any[]) ?? [])[0]?.moneda ?? 'MXN');

    // Movimientos de venta/devolución en el rango → unidades NETAS vendidas.
    let q = (supabase as any)
      .from('producto_movimientos')
      .select('producto_id, cantidad')
      .in('tipo', ['venta', 'devolucion'])
      .gte('created_at', dIni.toISOString())
      .lte('created_at', dFin.toISOString());
    if (sucursalId) q = q.eq('sucursal_id', sucursalId);
    const { data: movs } = await q;

    const unidades: Record<string, number> = {};
    for (const m of (movs as any[]) ?? []) {
      // venta es negativa, devolución positiva → −neto = lo que salió como venta.
      unidades[m.producto_id] = (unidades[m.producto_id] ?? 0) - m.cantidad;
    }

    const rows: Fila[] = Object.entries(unidades)
      .map(([id, u]) => {
        const c = cat[id];
        return {
          id,
          nombre: c?.nombre ?? 'Producto',
          unidades: u,
          ingreso: u * (c?.precio ?? 0),
          ganancia: c?.costo != null ? u * (c.precio - c.costo) : null
        };
      })
      .filter((r) => r.unidades > 0)
      .sort((a, b) => b.unidades - a.unidades);

    setFilas(rows);
    setCargando(false);
  }, [desde, hasta, sucursalId]);

  useEffect(() => { void cargar(); }, [cargar]);

  const totalUnidades = useMemo(() => filas.reduce((s, f) => s + f.unidades, 0), [filas]);
  const totalIngreso = useMemo(() => filas.reduce((s, f) => s + f.ingreso, 0), [filas]);
  const totalGanancia = useMemo(() => filas.reduce((s, f) => s + (f.ganancia ?? 0), 0), [filas]);
  const algunaSinCosto = useMemo(() => filas.some((f) => f.ganancia === null), [filas]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <label style={{ fontSize: 12, color: 'var(--ek-ink-muted)' }}>
          Desde<br /><input type="date" className="ek-input" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--ek-ink-muted)' }}>
          Hasta<br /><input type="date" className="ek-input" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} />
        </label>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ek-ink-faint)' }}>Ingreso del período</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>
            {fmt(totalIngreso, moneda)}
            {totalGanancia > 0 && <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ek-ink-faint)' }}> · ganancia {fmt(totalGanancia, moneda)}</span>}
          </div>
        </div>
      </div>

      {cargando ? (
        <p className="ek-body-muted">Cargando…</p>
      ) : filas.length === 0 ? (
        <div className="ek-card" style={{ padding: 28, textAlign: 'center' }}>
          <p className="ek-body-muted" style={{ margin: 0 }}>No hubo ventas en esas fechas.</p>
        </div>
      ) : (
        <>
          <div className="ek-card" style={{ padding: 0, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
              <thead>
                <tr>{['Producto', 'Unidades', 'Ingreso', 'Ganancia'].map((h, i) => (
                  <th key={i} style={{ ...th, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <tr key={f.id}>
                    <td style={td}>{f.nombre}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{f.unidades}</td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(f.ingreso, moneda)}</td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: f.ganancia == null ? 'var(--ek-ink-faint)' : 'var(--ek-ink)' }}>
                      {f.ganancia == null ? 'sin costo' : fmt(f.ganancia, moneda)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ ...td, fontWeight: 700 }}>Total</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{totalUnidades}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt(totalIngreso, moneda)}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt(totalGanancia, moneda)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="ek-body-muted" style={{ fontSize: 11.5, marginTop: 10 }}>
            Ingreso y ganancia estimados al precio/costo actual. Las ventas canceladas ya están descontadas.
            {algunaSinCosto && ' Los productos "sin costo" no suman a la ganancia — captúrales el costo para verla.'}
          </p>
        </>
      )}
    </div>
  );
}

const th: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ek-ink-faint)', padding: '10px 14px', borderBottom: '1px solid var(--ek-line)' };
const td: React.CSSProperties = { padding: '11px 14px', borderBottom: '1px solid var(--ek-line)' };
