import { useEffect, useMemo, useState } from 'react';
import { ShoppingBag } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';

/* ══════════════════════════════════════════════════════════════════════════
   TIENDA DEL SOCIO — comprá desde tu móvil.
   ──────────────────────────────────────────────────────────────────────────
   Solo visible si el gym prendió la venta desde la app (config.tienda.venta_socio).
   El PAGO con la tarjeta guardada es el próximo paso; por ahora se navega y se
   arma el carrito.
   ══════════════════════════════════════════════════════════════════════════ */

interface Producto {
  id: string;
  nombre: string;
  categoria: string | null;
  precio_centavos: number;
  moneda: string;
  foto_url: string | null;
}

const fmt = (c: number, m = 'MXN') =>
  (c / 100).toLocaleString('es-MX', { style: 'currency', currency: m, maximumFractionDigits: 0 });

export default function Tienda() {
  const toast = useToast();
  const [productos, setProductos] = useState<Producto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [carrito, setCarrito] = useState<Record<string, number>>({});
  const [comprando, setComprando] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data } = await (supabase as any)
        .from('productos')
        .select('id, nombre, categoria, precio_centavos, moneda, foto_url')
        .eq('activo', true)
        .order('nombre');
      setProductos((data as Producto[]) ?? []);
      setCargando(false);
    })();
  }, []);

  const agregar = (id: string) => setCarrito((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }));
  const quitar = (id: string) =>
    setCarrito((c) => {
      const n = (c[id] ?? 0) - 1;
      const next = { ...c };
      if (n <= 0) delete next[id]; else next[id] = n;
      return next;
    });

  const items = useMemo(
    () => Object.entries(carrito).map(([id, cant]) => ({ prod: productos.find((p) => p.id === id)!, cant })).filter((x) => x.prod),
    [carrito, productos]
  );
  const total = items.reduce((s, x) => s + x.prod.precio_centavos * x.cant, 0);
  const moneda = items[0]?.prod.moneda ?? 'MXN';

  async function comprar() {
    setComprando(true);
    // El cobro con la tarjeta guardada (Stripe Connect) es el próximo paso.
    await new Promise((r) => setTimeout(r, 400));
    setComprando(false);
    toast.info('El pago desde tu app llega muy pronto — con la tarjeta que ya tenés guardada.');
  }

  if (cargando) return <div style={{ padding: 32, textAlign: 'center', color: 'var(--ek-ink-faint)' }}>Cargando la tienda…</div>;

  return (
    <div style={{ paddingBottom: items.length > 0 ? 92 : 0 }}>
      <h1 className="ek-h1" style={{ marginBottom: 4 }}>Tienda</h1>
      <p className="ek-body-muted" style={{ marginTop: 0, marginBottom: 20 }}>Comprá desde tu móvil y retiralo en el gym.</p>

      {productos.length === 0 ? (
        <div className="ek-card" style={{ padding: 28, textAlign: 'center' }}>
          <ShoppingBag size={28} style={{ color: 'var(--ek-ink-faint)' }} />
          <p className="ek-body-muted" style={{ marginTop: 10 }}>Todavía no hay productos.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 12 }}>
          {productos.map((p) => {
            const enCarrito = carrito[p.id] ?? 0;
            return (
              <div key={p.id} className="ek-card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {p.foto_url
                  ? <img src={p.foto_url} alt="" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 10 }} />
                  : <div style={{ width: '100%', aspectRatio: '1', borderRadius: 10, background: 'var(--ek-bg-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ShoppingBag size={24} style={{ color: 'var(--ek-ink-faint)' }} /></div>}
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.2 }}>{p.nombre}</div>
                  {p.categoria && <div style={{ fontSize: 11.5, color: 'var(--ek-ink-faint)' }}>{p.categoria}</div>}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto' }}>
                  <span style={{ fontWeight: 700 }}>{fmt(p.precio_centavos, p.moneda)}</span>
                  {enCarrito === 0 ? (
                    <button onClick={() => agregar(p.id)} className="ek-btn-secondary" style={{ padding: '5px 12px', fontSize: 13 }}>Agregar</button>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button onClick={() => quitar(p.id)} style={btnQty}>−</button>
                      <b style={{ minWidth: 16, textAlign: 'center' }}>{enCarrito}</b>
                      <button onClick={() => agregar(p.id)} style={btnQty}>＋</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Barra de compra fija abajo cuando hay algo en el carrito. */}
      {items.length > 0 && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 72, padding: '0 16px', zIndex: 20 }}>
          <button
            onClick={comprar}
            disabled={comprando}
            className="ek-cta"
            style={{ width: '100%', maxWidth: 560, margin: '0 auto', minHeight: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', boxShadow: '0 8px 24px rgba(0,0,0,.18)' }}
          >
            <span>{comprando ? 'Procesando…' : 'Comprar'}</span>
            <span style={{ fontWeight: 800 }}>{fmt(total, moneda)}</span>
          </button>
        </div>
      )}
    </div>
  );
}

const btnQty: React.CSSProperties = {
  width: 26, height: 26, borderRadius: 7, border: '1px solid var(--ek-line)', background: 'var(--ek-bg-soft)',
  cursor: 'pointer', fontSize: 15, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center'
};
