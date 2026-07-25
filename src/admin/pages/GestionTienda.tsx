import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { backendPost } from '@shared/lib/backend';
import { useTenant, useTenantRefetch } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { useSucursal } from '../providers/SucursalProvider';
import ImageUploader from '../components/ImageUploader';

/* ══════════════════════════════════════════════════════════════════════════
   ADMIN → TIENDA (gestión)
   ──────────────────────────────────────────────────────────────────────────
   El dueño ADMINISTRA acá: carga productos, precios, fotos y stock. VENDER pasa
   en recepción o en la estación (otra pantalla, otro momento).

   El stock es POR SUCURSAL: se muestra y se carga sobre la sede operativa
   (`sucursalId`). Se lee de la vista `producto_stock`, que ya respeta la RLS.
   ══════════════════════════════════════════════════════════════════════════ */

interface Producto {
  id: string;
  nombre: string;
  categoria: string | null;
  precio_centavos: number;
  moneda: string;
  foto_url: string | null;
  activo: boolean;
}

const fmt = (centavos: number, moneda = 'MXN') =>
  (centavos / 100).toLocaleString('es-MX', { style: 'currency', currency: moneda, maximumFractionDigits: 0 });

export default function GestionTienda() {
  const tenant = useTenant();
  const toast = useToast();
  const refetchTenant = useTenantRefetch();
  const { sucursalId, sucursalActiva, multisede } = useSucursal();

  const [productos, setProductos] = useState<Producto[]>([]);
  const [stock, setStock] = useState<Record<string, number>>({});
  const [ventasHoy, setVentasHoy] = useState({ total: 0, count: 0 });
  const [cargando, setCargando] = useState(true);
  const [editando, setEditando] = useState<Producto | 'nuevo' | null>(null);
  const [cargandoStock, setCargandoStock] = useState<Producto | null>(null);
  const [cancelando, setCancelando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data: prods } = await (supabase as any)
      .from('productos')
      .select('id, nombre, categoria, precio_centavos, moneda, foto_url, activo')
      .order('nombre');
    setProductos((prods as Producto[]) ?? []);

    // Stock de la sede operativa. Si no hay sede (gym sin sucursales cargadas),
    // se suma todo — un gym así opera como una sola ubicación.
    let q = (supabase as any).from('producto_stock').select('producto_id, stock, sucursal_id');
    if (sucursalId) q = q.eq('sucursal_id', sucursalId);
    const { data: stk } = await q;
    const mapa: Record<string, number> = {};
    for (const row of (stk as { producto_id: string; stock: number }[]) ?? []) {
      mapa[row.producto_id] = (mapa[row.producto_id] ?? 0) + Number(row.stock);
    }
    setStock(mapa);

    // Ventas de producto de HOY (desde las 00:00 local). Salen de la Caja
    // (`pagos`, concepto 'producto'); el admin las puede leer (is_recepcionista
    // incluye admin). Se filtra por sede si hay una elegida.
    const inicioDia = new Date();
    inicioDia.setHours(0, 0, 0, 0);
    let vq = (supabase as any)
      .from('pagos')
      .select('monto_centavos')
      .eq('concepto', 'producto')
      .gte('created_at', inicioDia.toISOString());
    if (sucursalId) vq = vq.eq('sucursal_id', sucursalId);
    const { data: ventas } = await vq;
    const filas = (ventas as { monto_centavos: number }[]) ?? [];
    setVentasHoy({ total: filas.reduce((s, v) => s + Number(v.monto_centavos), 0), count: filas.length });

    setCargando(false);
  }, [sucursalId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const stockBajo = useMemo(
    () => productos.filter((p) => p.activo && (stock[p.id] ?? 0) <= 3).length,
    [productos, stock]
  );

  async function cancelarTienda() {
    if (!confirm('¿Dar de baja la tienda? Dejás de pagar el complemento y desaparece del menú. Tus productos y ventas quedan guardados por si la reactivás.')) return;
    setCancelando(true);
    try {
      await backendPost('complemento-saas', { modulo: 'tienda', accion: 'cancelar' });
      toast.success('Tienda dada de baja. Puede tardar unos segundos en desaparecer.');
      // El webhook apaga el módulo; se refresca el tenant para que la pantalla
      // vuelva sola a la de activación.
      for (const espera of [2000, 3000]) {
        await new Promise((r) => setTimeout(r, espera));
        await refetchTenant();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo dar de baja');
    } finally {
      setCancelando(false);
    }
  }

  if (cargando) return <div className="adm-page"><p className="ek-body-muted">Cargando tu tienda…</p></div>;

  return (
    <div className="adm-page">
      <div className="adm-page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <p className="ek-eyebrow">TIENDA</p>
          <h1 className="ek-h2" style={{ margin: 0 }}>Tus productos</h1>
          <p className="ek-body-muted" style={{ marginTop: 6, fontSize: 13 }}>
            {multisede && sucursalActiva ? <>Stock de <b>{sucursalActiva.nombre}</b> · </> : null}
            {productos.filter((p) => p.activo).length} activos
            {stockBajo > 0 && <> · <span style={{ color: 'var(--ek-danger)' }}>{stockBajo} con poco stock</span></>}
          </p>
        </div>
        <button className="ek-cta" onClick={() => setEditando('nuevo')}>＋ Producto</button>
      </div>

      {/* Ventas de hoy — lo primero que el dueño quiere saber al abrir. */}
      <div className="ek-card" style={{ display: 'flex', gap: 28, padding: '16px 22px', marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ek-ink-faint)' }}>Vendido hoy</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--ek-ink)', marginTop: 2 }}>{fmt(ventasHoy.total)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ek-ink-faint)' }}>Ventas</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--ek-ink)', marginTop: 2 }}>{ventasHoy.count}</div>
        </div>
      </div>

      {productos.length === 0 ? (
        <div className="ek-card" style={{ padding: 32, textAlign: 'center' }}>
          <p className="ek-body-muted" style={{ margin: 0 }}>
            Todavía no cargaste ningún producto. Empezá con lo que más vendés —agua, proteína—.
          </p>
        </div>
      ) : (
        <div className="ek-card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr>
                {['Producto', 'Categoría', 'Precio', 'Stock', ''].map((h, i) => (
                  <th key={i} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {productos.map((p) => {
                const s = stock[p.id] ?? 0;
                return (
                  <tr key={p.id} style={{ opacity: p.activo ? 1 : 0.5 }}>
                    <td style={td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {p.foto_url
                          ? <img src={p.foto_url} alt="" width={34} height={34} style={{ borderRadius: 8, objectFit: 'cover' }} />
                          : <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--ek-bg-soft)' }} />}
                        <span style={{ fontWeight: 600 }}>{p.nombre}{!p.activo && ' (inactivo)'}</span>
                      </div>
                    </td>
                    <td style={{ ...td, color: 'var(--ek-ink-muted)' }}>{p.categoria || '—'}</td>
                    <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{fmt(p.precio_centavos, p.moneda)}</td>
                    <td style={{ ...td, fontVariantNumeric: 'tabular-nums', color: s <= 0 ? 'var(--ek-danger)' : s <= 3 ? 'var(--ek-mustard)' : 'var(--ek-ink)', fontWeight: 700 }}>
                      {s}
                    </td>
                    <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="ek-btn-secondary" onClick={() => setCargandoStock(p)} style={btnMini}>Stock</button>
                      <button className="ek-btn-secondary" onClick={() => setEditando(p)} style={btnMini}>Editar</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Baja del complemento — discreta, al pie, con confirmación. */}
      <div style={{ marginTop: 28, textAlign: 'center' }}>
        <button
          onClick={cancelarTienda}
          disabled={cancelando}
          style={{ background: 'none', border: 'none', color: 'var(--ek-ink-faint)', fontSize: 12.5, cursor: 'pointer', textDecoration: 'underline' }}
        >
          {cancelando ? 'Dando de baja…' : 'Dar de baja la tienda'}
        </button>
      </div>

      {editando && (
        <ProductoForm
          tenantId={tenant.id}
          producto={editando === 'nuevo' ? null : editando}
          onClose={() => setEditando(null)}
          onGuardado={() => { setEditando(null); void cargar(); }}
        />
      )}

      {cargandoStock && (
        <StockForm
          producto={cargandoStock}
          sucursalId={sucursalId}
          stockActual={stock[cargandoStock.id] ?? 0}
          onClose={() => setCargandoStock(null)}
          onGuardado={() => { setCargandoStock(null); void cargar(); }}
        />
      )}
    </div>
  );

  // ── Sub-componentes ───────────────────────────────────────────────────────

  function ProductoForm({
    tenantId, producto, onClose, onGuardado
  }: { tenantId: string; producto: Producto | null; onClose: () => void; onGuardado: () => void }) {
    const [nombre, setNombre] = useState(producto?.nombre ?? '');
    const [categoria, setCategoria] = useState(producto?.categoria ?? '');
    const [precio, setPrecio] = useState(producto ? String(producto.precio_centavos / 100) : '');
    const [fotoUrl, setFotoUrl] = useState(producto?.foto_url ?? '');
    const [activo, setActivo] = useState(producto?.activo ?? true);
    const [guardando, setGuardando] = useState(false);

    async function guardar() {
      const centavos = Math.round(Number(precio) * 100);
      if (!nombre.trim()) return toast.error('Ponele un nombre');
      if (!Number.isFinite(centavos) || centavos < 0) return toast.error('El precio no es válido');
      setGuardando(true);
      const fila = {
        tenant_id: tenantId,
        nombre: nombre.trim(),
        categoria: categoria.trim() || null,
        precio_centavos: centavos,
        foto_url: fotoUrl || null,
        activo
      };
      const { error } = producto
        ? await (supabase as any).from('productos').update(fila).eq('id', producto.id)
        : await (supabase as any).from('productos').insert(fila);
      setGuardando(false);
      if (error) return toast.error('No se pudo guardar: ' + error.message);
      toast.success(producto ? 'Producto actualizado' : 'Producto creado');
      onGuardado();
    }

    return (
      <Overlay onClose={onClose}>
        <h2 className="ek-h3" style={{ marginTop: 0 }}>{producto ? 'Editar producto' : 'Nuevo producto'}</h2>
        <label style={lbl}>Nombre</label>
        <input className="ek-input" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Proteína chocolate" />
        <label style={lbl}>Categoría <span style={{ color: 'var(--ek-ink-faint)' }}>(opcional)</span></label>
        <input className="ek-input" value={categoria} onChange={(e) => setCategoria(e.target.value)} placeholder="Suplementos" />
        <label style={lbl}>Precio</label>
        <input className="ek-input" type="number" inputMode="decimal" value={precio} onChange={(e) => setPrecio(e.target.value)} placeholder="150" />
        <label style={lbl}>Foto <span style={{ color: 'var(--ek-ink-faint)' }}>(opcional)</span></label>
        <ImageUploader
          bucket="tenant-media"
          pathPrefix={`${tenantId}/productos`}
          currentUrl={fotoUrl || null}
          onUploaded={setFotoUrl}
          onError={(e) => toast.error(e)}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} />
          <span style={{ fontSize: 14 }}>Activo (se puede vender)</span>
        </label>
        <div style={acciones}>
          <button className="ek-btn-secondary" onClick={onClose}>Cancelar</button>
          <button className="ek-cta" onClick={guardar} disabled={guardando}>
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </Overlay>
    );
  }

  function StockForm({
    producto, sucursalId, stockActual, onClose, onGuardado
  }: { producto: Producto; sucursalId: string | null; stockActual: number; onClose: () => void; onGuardado: () => void }) {
    const [tipo, setTipo] = useState<'entrada' | 'merma' | 'ajuste'>('entrada');
    const [cantidad, setCantidad] = useState('');
    const [motivo, setMotivo] = useState('');
    const [guardando, setGuardando] = useState(false);

    async function guardar() {
      const n = Math.round(Number(cantidad));
      if (!Number.isFinite(n) || n === 0) return toast.error('La cantidad no puede ser cero');
      // entrada suma, merma resta, ajuste va con el signo que ponga el dueño.
      const delta = tipo === 'entrada' ? Math.abs(n) : tipo === 'merma' ? -Math.abs(n) : n;
      setGuardando(true);
      const { error } = await supabase.rpc('ajustar_stock' as never, {
        p_producto_id: producto.id,
        p_sucursal_id: sucursalId,
        p_cantidad: delta,
        p_tipo: tipo,
        p_motivo: motivo.trim() || null
      } as never);
      setGuardando(false);
      if (error) return toast.error('No se pudo: ' + error.message);
      toast.success('Stock actualizado');
      onGuardado();
    }

    return (
      <Overlay onClose={onClose}>
        <h2 className="ek-h3" style={{ marginTop: 0 }}>Stock · {producto.nombre}</h2>
        <p className="ek-body-muted" style={{ marginTop: 0, fontSize: 13 }}>Ahora hay <b>{stockActual}</b>.</p>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {([['entrada', 'Entrada'], ['merma', 'Merma'], ['ajuste', 'Ajuste']] as const).map(([v, l]) => (
            <button
              key={v}
              onClick={() => setTipo(v)}
              className="ek-btn-secondary"
              style={{ flex: 1, ...(tipo === v ? { background: 'var(--sala-primary)', color: '#fff' } : {}) }}
            >
              {l}
            </button>
          ))}
        </div>
        <label style={lbl}>{tipo === 'ajuste' ? 'Cantidad (con − para restar)' : 'Cantidad'}</label>
        <input className="ek-input" type="number" inputMode="numeric" value={cantidad} onChange={(e) => setCantidad(e.target.value)} placeholder="12" />
        <label style={lbl}>Motivo <span style={{ color: 'var(--ek-ink-faint)' }}>(opcional)</span></label>
        <input className="ek-input" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder={tipo === 'merma' ? 'Caducó' : 'Compra al proveedor'} />
        <div style={acciones}>
          <button className="ek-btn-secondary" onClick={onClose}>Cancelar</button>
          <button className="ek-cta" onClick={guardar} disabled={guardando}>
            {guardando ? 'Guardando…' : 'Registrar'}
          </button>
        </div>
      </Overlay>
    );
  }
}

// ── Overlay simple (modal) ────────────────────────────────────────────────────
function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--ek-bg)', borderRadius: 16, padding: 24, width: '100%', maxWidth: 440, maxHeight: '92vh', overflowY: 'auto' }}
      >
        {children}
      </div>
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ek-ink-faint)', padding: '10px 14px', borderBottom: '1px solid var(--ek-line)' };
const td: React.CSSProperties = { padding: '11px 14px', borderBottom: '1px solid var(--ek-line)' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--ek-ink-muted)', margin: '14px 0 5px' };
const acciones: React.CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 };
const btnMini: React.CSSProperties = { fontSize: 12, padding: '5px 10px', marginLeft: 6 };