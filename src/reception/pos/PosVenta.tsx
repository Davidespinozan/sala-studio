import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShoppingBag } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import { useReceptionSucursal } from '../providers/ReceptionSucursalProvider';

/* ══════════════════════════════════════════════════════════════════════════
   POS — el motor de venta.
   ──────────────────────────────────────────────────────────────────────────
   La MISMA pieza se usa en dos superficies: dentro de recepción (el caso común,
   la mercancía está en el mostrador) y en la estación standalone (modo kiosko).
   Por eso vive en un componente aparte y no atado a una pantalla.

   Vender = elegir productos, cobrar, y que la venta entre a la Caja con el stock
   descontado — todo atómico, en la RPC `vender_productos`. El precio se congela
   del catálogo en el momento de la venta.
   ══════════════════════════════════════════════════════════════════════════ */

interface Producto {
  id: string;
  nombre: string;
  precio_centavos: number;
  moneda: string;
  foto_url: string | null;
}

type Metodo = 'efectivo' | 'tarjeta' | 'transferencia';

const fmt = (c: number, m = 'MXN') =>
  (c / 100).toLocaleString('es-MX', { style: 'currency', currency: m, maximumFractionDigits: 0 });

export default function PosVenta() {
  const toast = useToast();
  const { sucursalId } = useReceptionSucursal();

  const [productos, setProductos] = useState<Producto[]>([]);
  const [stock, setStock] = useState<Record<string, number>>({});
  const [cargando, setCargando] = useState(true);
  const [carrito, setCarrito] = useState<Record<string, number>>({}); // producto_id → cantidad
  const [metodo, setMetodo] = useState<Metodo>('efectivo');
  const [recibido, setRecibido] = useState(''); // con cuánto paga (efectivo)
  const [cobrando, setCobrando] = useState(false);
  // A quién se le vende. Opcional: default "Público" (venta a la calle).
  const [socio, setSocio] = useState<{ id: string; nombre: string } | null>(null);
  const [buscaSocio, setBuscaSocio] = useState('');
  const [resultadosSocio, setResultadosSocio] = useState<{ id: string; nombre: string }[]>([]);

  useEffect(() => {
    const q = buscaSocio.trim();
    if (socio || q.length < 2) { setResultadosSocio([]); return; }
    let vivo = true;
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('usuarios')
        .select('id, nombre')
        .eq('rol', 'miembro')
        .ilike('nombre', `%${q}%`)
        .limit(6);
      if (vivo) setResultadosSocio((data as { id: string; nombre: string }[]) ?? []);
    }, 250);
    return () => { vivo = false; clearTimeout(t); };
  }, [buscaSocio, socio]);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data: prods } = await (supabase as any)
      .from('productos')
      .select('id, nombre, precio_centavos, moneda, foto_url')
      .eq('activo', true)
      .order('nombre');
    setProductos((prods as Producto[]) ?? []);

    let q = (supabase as any).from('producto_stock').select('producto_id, stock, sucursal_id');
    if (sucursalId) q = q.eq('sucursal_id', sucursalId);
    const { data: stk } = await q;
    const mapa: Record<string, number> = {};
    for (const r of (stk as { producto_id: string; stock: number }[]) ?? []) {
      mapa[r.producto_id] = (mapa[r.producto_id] ?? 0) + Number(r.stock);
    }
    setStock(mapa);
    setCargando(false);
  }, [sucursalId]);

  useEffect(() => { void cargar(); }, [cargar]);

  const agregar = (id: string) => setCarrito((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }));
  const quitar = (id: string) =>
    setCarrito((c) => {
      const n = (c[id] ?? 0) - 1;
      const next = { ...c };
      if (n <= 0) delete next[id]; else next[id] = n;
      return next;
    });

  const items = useMemo(
    () => Object.entries(carrito).map(([id, cant]) => ({ prod: productos.find((p) => p.id === id)!, cant }))
      .filter((x) => x.prod),
    [carrito, productos]
  );
  const total = items.reduce((s, x) => s + x.prod.precio_centavos * x.cant, 0);
  const moneda = items[0]?.prod.moneda ?? 'MXN';

  // Vuelto: solo aplica al efectivo. Si no pusieron con cuánto paga, se asume
  // pago justo (cambio 0).
  const recibidoCent = Math.round((Number(recibido) || 0) * 100);
  const vuelto = metodo === 'efectivo' && recibidoCent > total ? recibidoCent - total : 0;
  const faltaEfectivo = metodo === 'efectivo' && recibido !== '' && recibidoCent < total;

  async function cobrar() {
    if (items.length === 0) return;
    if (faltaEfectivo) return toast.error('Lo que te dieron no alcanza el total');
    setCobrando(true);
    const { error } = await supabase.rpc('vender_productos' as never, {
      p_sucursal_id: sucursalId,
      p_metodo: metodo,
      p_items: items.map((x) => ({ producto_id: x.prod.id, cantidad: x.cant })),
      p_usuario_id: socio?.id ?? null
    } as never);
    setCobrando(false);
    if (error) return toast.error('No se pudo cobrar: ' + error.message);
    // Al cobrar en efectivo con vuelto, lo primero que la recepcionista necesita
    // es cuánto cambio dar — se lo dejamos bien grande en el aviso.
    toast.success(vuelto > 0 ? `Cobrado ${fmt(total, moneda)} · Cambio ${fmt(vuelto, moneda)}` : `Cobrado ${fmt(total, moneda)}${socio ? ` · ${socio.nombre}` : ''}`);
    setCarrito({});
    setSocio(null);
    setBuscaSocio('');
    setRecibido('');
    void cargar();
  }

  if (cargando) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--ek-ink-faint)' }}>Cargando la tienda…</div>;

  if (productos.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <ShoppingBag size={32} style={{ color: 'var(--ek-ink-faint)' }} />
        <p className="ek-body-muted" style={{ marginTop: 12 }}>
          Todavía no hay productos cargados. El admin los agrega desde su panel.
        </p>
      </div>
    );
  }

  return (
    <div style={{ gap: 16, alignItems: 'start' }} className="pos-grid">
      {/* Grilla de productos */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 10 }}>
        {productos.map((p) => {
          const s = stock[p.id] ?? 0;
          return (
            <button
              key={p.id}
              onClick={() => agregar(p.id)}
              style={{
                textAlign: 'left', background: 'var(--ek-bg)', border: '1px solid var(--ek-line)',
                borderRadius: 12, padding: 10, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6
              }}
            >
              {p.foto_url
                ? <img src={p.foto_url} alt="" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8 }} />
                : <div style={{ width: '100%', aspectRatio: '1', borderRadius: 8, background: 'var(--ek-bg-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ShoppingBag size={22} style={{ color: 'var(--ek-ink-faint)' }} /></div>}
              <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2 }}>{p.nombre}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontWeight: 700 }}>{fmt(p.precio_centavos, p.moneda)}</span>
                <span style={{ fontSize: 11, color: s <= 0 ? 'var(--ek-danger)' : 'var(--ek-ink-faint)' }}>{s} en stock</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Carrito */}
      <div style={{ background: 'var(--ek-bg)', border: '1px solid var(--ek-line)', borderRadius: 16, padding: 16, position: 'sticky', top: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ek-ink-faint)', marginBottom: 12 }}>La venta</div>

        {items.length === 0 ? (
          <p className="ek-body-muted" style={{ fontSize: 13 }}>Toca un producto para agregarlo.</p>
        ) : (
          <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
            {items.map((x) => (
              <div key={x.prod.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.prod.nombre}</div>
                  <div style={{ color: 'var(--ek-ink-faint)', fontSize: 12 }}>{fmt(x.prod.precio_centavos * x.cant, x.prod.moneda)}</div>
                </div>
                <button onClick={() => quitar(x.prod.id)} style={btnQty}>−</button>
                <span style={{ minWidth: 18, textAlign: 'center', fontWeight: 700 }}>{x.cant}</span>
                <button onClick={() => agregar(x.prod.id)} style={btnQty}>＋</button>
              </div>
            ))}
          </div>
        )}

        {/* A quién — opcional. Si no se elige, la venta es "al público". */}
        <div style={{ marginBottom: 12, position: 'relative' }}>
          {socio ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, background: 'var(--ek-bg-soft)', borderRadius: 8, padding: '7px 10px' }}>
              <span style={{ flex: 1 }}>Socio: <b>{socio.nombre}</b></span>
              <button onClick={() => setSocio(null)} style={{ background: 'none', border: 'none', color: 'var(--ek-ink-faint)', cursor: 'pointer', fontSize: 12 }}>quitar</button>
            </div>
          ) : (
            <>
              <input
                className="ek-input"
                value={buscaSocio}
                onChange={(e) => setBuscaSocio(e.target.value)}
                placeholder="¿Socio? (opcional) — buscá por nombre"
                style={{ fontSize: 13 }}
              />
              {resultadosSocio.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, background: 'var(--ek-bg)', border: '1px solid var(--ek-line)', borderRadius: 8, marginTop: 4, boxShadow: '0 8px 24px rgba(0,0,0,.12)' }}>
                  {resultadosSocio.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => { setSocio(r); setBuscaSocio(''); setResultadosSocio([]); }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '9px 12px', fontSize: 13, cursor: 'pointer' }}
                    >
                      {r.nombre}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--ek-line)', paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ color: 'var(--ek-ink-muted)' }}>Total</span>
          <span style={{ fontSize: 22, fontWeight: 800 }}>{fmt(total, moneda)}</span>
        </div>

        <div style={{ display: 'flex', gap: 6, margin: '14px 0' }}>
          {(['efectivo', 'tarjeta', 'transferencia'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMetodo(m)}
              className={metodo === m ? 'ek-cta' : 'ek-cta ek-cta--secondary'}
              style={{ flex: 1, fontSize: 12, padding: '7px 4px' }}
            >
              {m === 'efectivo' ? 'Efectivo' : m === 'tarjeta' ? 'Terminal' : 'Transf.'}
            </button>
          ))}
        </div>

        {/* Efectivo: con cuánto paga → cuánto cambio dar. */}
        {metodo === 'efectivo' && total > 0 && (
          <div style={{ marginBottom: 12 }}>
            <input
              className="ek-input"
              type="number"
              inputMode="numeric"
              value={recibido}
              onChange={(e) => setRecibido(e.target.value)}
              placeholder="¿Con cuánto paga? (deja vacío si es justo)"
              style={{ fontSize: 13 }}
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              {[...new Set([Math.ceil(total / 100), 50, 100, 200, 500].filter((n) => n >= total / 100))]
                .sort((a, b) => a - b)
                .slice(0, 4)
                .map((n) => (
                  <button
                    key={n}
                    onClick={() => setRecibido(String(n))}
                    className="ek-cta ek-cta--secondary"
                    style={{ flex: 1, fontSize: 12, padding: '6px 4px' }}
                  >
                    {n === Math.ceil(total / 100) ? 'Justo' : `$${n}`}
                  </button>
                ))}
            </div>
            {vuelto > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 15 }}>
                <span style={{ color: 'var(--ek-ink-muted)' }}>Cambio</span>
                <b style={{ color: 'var(--ek-ok, #34d399)' }}>{fmt(vuelto, moneda)}</b>
              </div>
            )}
            {faltaEfectivo && (
              <div style={{ marginTop: 8, fontSize: 13, color: 'var(--ek-danger)' }}>Falta {fmt(total - recibidoCent, moneda)}</div>
            )}
          </div>
        )}

        <button
          className="ek-cta"
          onClick={cobrar}
          disabled={items.length === 0 || cobrando}
          style={{ width: '100%', minHeight: 48, justifyContent: 'center' }}
        >
          {cobrando ? 'Cobrando…' : items.length === 0 ? 'Cobrar' : `Cobrar ${fmt(total, moneda)}`}
        </button>
      </div>
    </div>
  );
}

const btnQty: React.CSSProperties = {
  width: 40, height: 40, borderRadius: 8, border: '1px solid var(--ek-line)',
  background: 'var(--ek-bg-soft)', cursor: 'pointer', fontSize: 16, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center'
};
