import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingBag } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { backendPost } from '@shared/lib/backend';
import { useToast } from '@shared/hooks/useToast';
import { useTenant } from '@shared/hooks/useTenant';
import { entregaOpciones } from '@shared/lib/tiendaConfig';

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
  const navigate = useNavigate();
  const tenant = useTenant();
  const entrega = entregaOpciones(tenant.config as Record<string, unknown> | null);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [carrito, setCarrito] = useState<Record<string, number>>({});
  const [comprando, setComprando] = useState(false);
  const [enCheckout, setEnCheckout] = useState(false);
  // Cómo quiere recibir lo que compra. Se inicializa con la primera opción que
  // el gym tenga habilitada.
  const opcionesEntrega = (['recepcion', 'tienda', 'llevar'] as const).filter((k) => entrega[k]);
  const [entregaTipo, setEntregaTipo] = useState<'recepcion' | 'tienda' | 'llevar'>(opcionesEntrega[0] ?? 'recepcion');
  const [ubicacion, setUbicacion] = useState('');

  async function recargarProductos() {
    const { data } = await (supabase as any)
      .from('productos')
      .select('id, nombre, categoria, precio_centavos, moneda, foto_url')
      .eq('activo', true)
      .order('nombre');
    setProductos((data as Producto[]) ?? []);
    setCargando(false);
  }

  useEffect(() => {
    void recargarProductos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function pagar() {
    if (entregaTipo === 'llevar' && !ubicacion.trim()) {
      toast.error('Dinos dónde estás para llevártelo');
      return;
    }
    setComprando(true);
    try {
      const r = await backendPost<{ paid: boolean; reason?: string; mensaje?: string }>('comprar-producto', {
        items: items.map((x) => ({ producto_id: x.prod.id, cantidad: x.cant })),
        entrega_tipo: entregaTipo,
        entrega_ubicacion: entregaTipo === 'llevar' ? ubicacion.trim() : undefined
      });

      if (r.paid) {
        toast.success(
          entregaTipo === 'recepcion' ? '¡Listo! Pasa a recepción a recogerlo.'
          : entregaTipo === 'tienda' ? '¡Listo! Pasa a la tienda a recogerlo.'
          : '¡Listo! Te lo llevamos.'
        );
        setCarrito({});
        setEnCheckout(false);
        return;
      }

      // No se cobró: cada motivo, su mensaje. 'sin_tarjeta' manda a agregar una.
      switch (r.reason) {
        case 'sin_tarjeta':
          toast.info('Agrega una tarjeta para comprar desde la app.');
          navigate('/app/perfil');
          break;
        case 'suspendido':
          toast.error('Tu cuenta está suspendida. Hablá con el gym.');
          break;
        case 'sin_stock':
          toast.error('Se agotó algo de tu carrito. Ajústalo e intenta de nuevo.');
          void recargarProductos();
          break;
        case 'rechazada':
          toast.error(r.mensaje || 'Tu tarjeta fue rechazada.');
          break;
        case 'requiere_autenticacion':
          toast.error('Tu banco pide confirmar el pago. Actualiza tu tarjeta en el perfil.');
          break;
        case 'no_disponible':
          toast.error('La compra desde la app no está disponible ahora.');
          break;
        case 'cobros_no_activos':
        case 'stripe_pendiente':
          toast.info('El gym todavía no tiene los cobros activos.');
          break;
        default:
          toast.error('No pudimos completar la compra. Intentá de nuevo.');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No pudimos completar la compra.');
    } finally {
      setComprando(false);
    }
  }

  if (cargando) return <div className="ek-container" style={{ paddingTop: '12px' }}><p className="ek-body-muted">Cargando la tienda…</p></div>;

  // ── Checkout: cómo lo recibe + pagar ──────────────────────────────────────
  if (enCheckout) {
    const etiqueta: Record<string, string> = {
      recepcion: 'Lo recojo en recepción',
      tienda: 'Lo recojo en la tienda',
      llevar: 'Que me lo lleven'
    };
    return (
      <div className="ek-container" style={{ paddingTop: '12px' }}>
        <button onClick={() => setEnCheckout(false)} style={{ background: 'none', border: 'none', color: 'var(--sala-primary)', fontSize: 14, fontWeight: 600, cursor: 'pointer', padding: 0, marginBottom: 12 }}>‹ Volver</button>
        <div className="ek-stack-md" style={{ marginBottom: 20 }}>
          <p className="ek-eyebrow">TU COMPRA</p>
          <h1 className="ek-display-md" style={{ margin: 0 }}>¿Cómo lo recibes?</h1>
        </div>

        <div style={{ display: 'grid', gap: 10, marginBottom: 20 }}>
          {opcionesEntrega.map((k) => (
            <button
              key={k}
              onClick={() => setEntregaTipo(k)}
              className="ek-card"
              style={{ textAlign: 'left', padding: '14px 16px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: entregaTipo === k ? '2px solid var(--sala-primary)' : '1px solid var(--ek-line)' }}
            >
              <span style={{ fontWeight: 600 }}>{etiqueta[k]}</span>
              {entregaTipo === k && <span style={{ color: 'var(--sala-primary)', fontWeight: 800 }}>✓</span>}
            </button>
          ))}
        </div>

        {entregaTipo === 'llevar' && (
          <div style={{ marginBottom: 20 }}>
            <label className="ek-body-muted" style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>¿Dónde te lo llevamos?</label>
            <input className="ek-input" value={ubicacion} onChange={(e) => setUbicacion(e.target.value)} placeholder="Sala de spinning, recepción…" />
          </div>
        )}

        <div className="ek-card" style={{ padding: '14px 16px', marginBottom: 20 }}>
          {items.map((x) => (
            <div key={x.prod.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 6 }}>
              <span>{x.cant}× {x.prod.nombre}</span>
              <span style={{ fontWeight: 600 }}>{fmt(x.prod.precio_centavos * x.cant, x.prod.moneda)}</span>
            </div>
          ))}
          <div style={{ borderTop: '1px solid var(--ek-line)', marginTop: 8, paddingTop: 8, display: 'flex', justifyContent: 'space-between', fontWeight: 800 }}>
            <span>Total</span><span>{fmt(total, moneda)}</span>
          </div>
        </div>

        <button onClick={pagar} disabled={comprando} className="ek-cta" style={{ width: '100%', minHeight: 52 }}>
          {comprando ? 'Procesando…' : `Pagar ${fmt(total, moneda)} con mi tarjeta`}
        </button>
        <p className="ek-body-muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 10 }}>
          Se cobra a la tarjeta que ya tienes guardada en el gym.
        </p>
      </div>
    );
  }

  return (
    <div className="ek-container" style={{ paddingTop: '12px', paddingBottom: items.length > 0 ? 80 : 0 }}>
      <div className="ek-stack-md" style={{ marginBottom: 20 }}>
        <p className="ek-eyebrow">TIENDA</p>
        <h1 className="ek-display-md" style={{ margin: 0 }}>Compra desde tu móvil</h1>
        <p className="ek-body-muted" style={{ margin: 0 }}>Elige lo que quieras y retíralo en el gym.</p>
      </div>

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
                    <button onClick={() => agregar(p.id)} className="ek-cta ek-cta--secondary" style={{ padding: '6px 14px', fontSize: 13, minHeight: 0 }}>Agregar</button>
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
            onClick={() => setEnCheckout(true)}
            className="ek-cta"
            style={{ width: '100%', maxWidth: 560, margin: '0 auto', minHeight: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', boxShadow: '0 8px 24px rgba(0,0,0,.18)' }}
          >
            <span>Continuar</span>
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
