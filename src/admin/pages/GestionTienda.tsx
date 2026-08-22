import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { backendPost } from '@shared/lib/backend';
import { useTenant, useTenantRefetch } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { getTenantTimezone, fechaEnTz, formatHoraEnTz } from '@shared/lib/timezone';
import { useSucursal } from '../providers/SucursalProvider';
import ImageUploader from '../components/ImageUploader';
import VentasTienda from '@shared/tienda/VentasTienda';
import ReportesTienda from '@shared/tienda/ReportesTienda';
import { ventaSocioActiva, conVentaSocio, entregaOpciones, conEntrega, type OpcionesEntrega } from '@shared/lib/tiendaConfig';

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
  costo_centavos: number | null;
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
  const [vista, setVista] = useState<'productos' | 'ventas' | 'reportes'>('productos');
  const [cargando, setCargando] = useState(true);
  const [editando, setEditando] = useState<Producto | 'nuevo' | null>(null);
  const [cargandoStock, setCargandoStock] = useState<Producto | null>(null);
  const [verMovimientos, setVerMovimientos] = useState<Producto | null>(null);
  const [cancelando, setCancelando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data: prods } = await (supabase as any)
      .from('productos')
      .select('id, nombre, categoria, precio_centavos, costo_centavos, moneda, foto_url, activo')
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
    setCargando(false);
  }, [sucursalId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const stockBajo = useMemo(
    () => productos.filter((p) => p.activo && (stock[p.id] ?? 0) <= 3).length,
    [productos, stock]
  );
  const unidadesTotales = useMemo(
    () => productos.filter((p) => p.activo).reduce((a, p) => a + (stock[p.id] ?? 0), 0),
    [productos, stock]
  );
  const valorInventario = useMemo(
    () => productos.filter((p) => p.activo).reduce((a, p) => a + (stock[p.id] ?? 0) * (p.costo_centavos ?? 0), 0),
    [productos, stock]
  );

  const config = (tenant.config as Record<string, unknown> | null) ?? {};
  const ventaSocio = ventaSocioActiva(config);
  const entrega = entregaOpciones(config);
  const [guardandoAjuste, setGuardandoAjuste] = useState(false);

  async function guardarConfig(next: Record<string, unknown>, msg: string) {
    setGuardandoAjuste(true);
    const { error } = await (supabase as any).from('tenants').update({ config: next }).eq('id', tenant.id);
    if (error) toast.error('No se pudo guardar: ' + error.message);
    else { toast.success(msg); await refetchTenant(); }
    setGuardandoAjuste(false);
  }

  const toggleVentaSocio = () =>
    guardarConfig(conVentaSocio(config, !ventaSocio),
      !ventaSocio ? 'Los socios ya pueden comprar desde su app' : 'Compra desde la app desactivada');

  function toggleEntrega(k: keyof OpcionesEntrega) {
    const next = { ...entrega, [k]: !entrega[k] };
    // No dejar al socio sin ninguna forma de recibir lo que compra.
    if (!next.recepcion && !next.tienda && !next.llevar) {
      toast.error('Deja al menos una forma de entrega');
      return;
    }
    guardarConfig(conEntrega(config, next), 'Formas de entrega actualizadas');
  }

  // Dar de baja / reactivar un producto (activo = false/true). Es lo recomendado:
  // conserva sus ventas históricas en la Caja. Un producto inactivo no aparece en
  // el POS ni se cuenta en stock/valor, pero su historial queda intacto.
  async function toggleActivo(p: Producto) {
    const nuevo = !p.activo;
    const { error } = await (supabase as any)
      .from('productos').update({ activo: nuevo }).eq('id', p.id);
    if (error) { toast.error('No se pudo actualizar: ' + error.message); return; }
    toast.success(nuevo ? 'Producto reactivado' : 'Producto dado de baja');
    await cargar();
  }

  // Borrar DE VERDAD un producto — solo si NUNCA tuvo movimientos (ventas/stock).
  // Si los tuvo, borrarlo arrastraría el ledger (FK cascade + append-only) y se
  // perdería el historial de la Caja → en ese caso hay que "Dar de baja", no borrar.
  async function eliminarProducto(p: Producto) {
    const { count } = await (supabase as any)
      .from('producto_movimientos')
      .select('id', { count: 'exact', head: true })
      .eq('producto_id', p.id);
    if ((count ?? 0) > 0) {
      toast.error('Ya tiene movimientos/ventas. Usa "Dar de baja" para conservar el historial.');
      return;
    }
    if (!confirm(`¿Eliminar "${p.nombre}" para siempre? No tiene ventas, así que se puede borrar.`)) return;
    const { error } = await (supabase as any).from('productos').delete().eq('id', p.id);
    if (error) { toast.error('No se pudo eliminar: ' + error.message); return; }
    toast.success('Producto eliminado');
    await cargar();
  }

  async function cancelarTienda() {
    if (!confirm('¿Dar de baja la tienda? Dejas de pagar el complemento y desaparece del menú. Tus productos y ventas quedan guardados por si la reactivas.')) return;
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
            {productos.filter((p) => p.activo).length} activos · {unidadesTotales} unidades en stock
            {valorInventario > 0 && <> · valor {fmt(valorInventario, productos[0]?.moneda ?? 'MXN')}</>}
            {stockBajo > 0 && <> · <span style={{ color: 'var(--ek-danger)' }}>{stockBajo} con poco stock</span></>}
          </p>
        </div>
        {vista === 'productos' && (
          <button className="ek-cta" onClick={() => setEditando('nuevo')}>＋ Producto</button>
        )}
      </div>

      {/* Pestañas: administrar el catálogo o ver el historial de ventas. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {(['productos', 'ventas', 'reportes'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setVista(v)}
            className={vista === v ? 'ek-cta' : 'ek-cta ek-cta--secondary'}
          >
            {v === 'productos' ? 'Productos' : v === 'ventas' ? 'Ventas' : 'Reportes'}
          </button>
        ))}
      </div>

      {vista === 'ventas' && <VentasTienda sucursalId={sucursalId} />}

      {vista === 'reportes' && <ReportesTienda sucursalId={sucursalId} />}

      {vista === 'productos' && (productos.length === 0 ? (
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
                      <button className="ek-cta ek-cta--secondary" onClick={() => setVerMovimientos(p)} style={btnMini}>Movimientos</button>
                      <button className="ek-cta ek-cta--secondary" onClick={() => setCargandoStock(p)} style={btnMini}>Stock</button>
                      <button className="ek-cta ek-cta--secondary" onClick={() => setEditando(p)} style={btnMini}>Editar</button>
                      <button className="ek-cta ek-cta--secondary" onClick={() => toggleActivo(p)} style={btnMini}>
                        {p.activo ? 'Dar de baja' : 'Reactivar'}
                      </button>
                      <button className="ek-cta ek-cta--secondary" onClick={() => eliminarProducto(p)} style={{ ...btnMini, color: 'var(--ek-danger)' }}>Eliminar</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {/* Ajuste: venta desde la app del socio. */}
      <div className="ek-card" style={{ marginTop: 24, padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Compra desde la app del socio</div>
            <div className="ek-body-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              El socio compra desde su móvil con la tarjeta que ya tiene guardada. Ideal si vende sin recepción de por medio.
            </div>
          </div>
          <button
            onClick={toggleVentaSocio}
            disabled={guardandoAjuste}
            className={ventaSocio ? 'ek-cta' : 'ek-cta ek-cta--secondary'}
          >
            {guardandoAjuste ? '…' : ventaSocio ? 'Activada' : 'Activar'}
          </button>
        </div>

        {/* Con la compra desde la app prendida: cómo recibe el socio lo que
            compra. El admin habilita las que apliquen a su negocio. */}
        {ventaSocio && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--ek-line)' }}>
            <div className="ek-body-muted" style={{ fontSize: 12.5, marginBottom: 10 }}>¿Cómo recibe el socio lo que compra?</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {([
                ['recepcion', 'Recoge en recepción'],
                ['tienda', 'Recoge en la tienda'],
                ['llevar', 'Se lo llevan (a su sala)']
              ] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => toggleEntrega(k)}
                  disabled={guardandoAjuste}
                  className={entrega[k] ? 'ek-cta' : 'ek-cta ek-cta--secondary'}
                >
                  {entrega[k] ? '✓ ' : ''}{label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Baja del complemento — discreta, al pie, con confirmación. */}
      <div style={{ marginTop: 20, textAlign: 'center' }}>
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

      {verMovimientos && (
        <MovimientosModal
          producto={verMovimientos}
          sucursalId={sucursalId}
          onClose={() => setVerMovimientos(null)}
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
    const [costo, setCosto] = useState(producto?.costo_centavos != null ? String(producto.costo_centavos / 100) : '');
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
        costo_centavos: costo.trim() ? Math.round(Number(costo) * 100) : null,
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
        <label style={lbl}>Precio <span style={{ color: 'var(--ek-ink-faint)' }}>(a cuánto lo vendes)</span></label>
        <input className="ek-input" type="number" inputMode="decimal" value={precio} onChange={(e) => setPrecio(e.target.value)} placeholder="150" />
        <label style={lbl}>Costo <span style={{ color: 'var(--ek-ink-faint)' }}>(a cuánto lo compras — para el margen)</span></label>
        <input className="ek-input" type="number" inputMode="decimal" value={costo} onChange={(e) => setCosto(e.target.value)} placeholder="90" />
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
          <button className="ek-cta ek-cta--secondary" onClick={onClose}>Cancelar</button>
          <button className="ek-cta" onClick={guardar} disabled={guardando}>
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </Overlay>
    );
  }

  function MovimientosModal({
    producto, sucursalId, onClose
  }: { producto: Producto; sucursalId: string | null; onClose: () => void }) {
    const tz = getTenantTimezone(tenant);
    const MOV_LABEL: Record<string, string> = {
      entrada: 'Entrada', venta: 'Venta', merma: 'Merma', ajuste: 'Ajuste', devolucion: 'Devolución'
    };
    type Fila = { id: string; tipo: string; cantidad: number; motivo: string | null; created_at: string; saldo: number; autor: string };
    const [movs, setMovs] = useState<Fila[]>([]);
    const [cargandoMov, setCargandoMov] = useState(true);

    useEffect(() => {
      let vivo = true;
      void (async () => {
        let q = (supabase as any)
          .from('producto_movimientos')
          .select('id, tipo, cantidad, motivo, created_at, created_by')
          .eq('producto_id', producto.id)
          .order('created_at', { ascending: true });
        if (sucursalId) q = q.eq('sucursal_id', sucursalId);
        const { data } = await q;
        const filas = (data as { id: string; tipo: string; cantidad: number; motivo: string | null; created_at: string; created_by: string | null }[]) ?? [];
        // Nombres de quién hizo cada movimiento.
        const ids = [...new Set(filas.map((m) => m.created_by).filter(Boolean))] as string[];
        const nombres: Record<string, string> = {};
        if (ids.length) {
          const { data: us } = await (supabase as any).from('usuarios').select('id, nombre').in('id', ids);
          for (const u of (us as { id: string; nombre: string | null }[]) ?? []) nombres[u.id] = u.nombre ?? '—';
        }
        // Saldo corrido (ascendente) y luego se muestra el más reciente primero.
        let saldo = 0;
        const conSaldo: Fila[] = filas.map((m) => {
          saldo += m.cantidad;
          return {
            id: m.id, tipo: m.tipo, cantidad: m.cantidad, motivo: m.motivo, created_at: m.created_at, saldo,
            autor: m.created_by ? (nombres[m.created_by] ?? '—') : (m.tipo === 'venta' ? 'Venta (POS)' : '—')
          };
        }).reverse();
        if (vivo) { setMovs(conSaldo); setCargandoMov(false); }
      })();
      return () => { vivo = false; };
    }, [producto.id, sucursalId]);

    return (
      <Overlay onClose={onClose}>
        <h2 className="ek-h3" style={{ marginTop: 0 }}>Movimientos · {producto.nombre}</h2>
        <p className="ek-body-muted" style={{ marginTop: 0, fontSize: 13 }}>
          Todo lo que entró y salió. El <b>saldo</b> es el stock después de cada movimiento.
        </p>
        {cargandoMov ? (
          <p className="ek-body-muted" style={{ textAlign: 'center', padding: 16, margin: 0 }}>Cargando…</p>
        ) : movs.length === 0 ? (
          <p className="ek-body-muted" style={{ textAlign: 'center', padding: 16, margin: 0 }}>Sin movimientos todavía.</p>
        ) : (
          <div style={{ maxHeight: 380, overflowY: 'auto', marginTop: 4 }}>
            {movs.map((m) => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 2px', borderTop: '1px solid var(--ek-line)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {MOV_LABEL[m.tipo] ?? m.tipo}
                    {m.motivo && <span style={{ fontWeight: 400, color: 'var(--ek-ink-muted)' }}> · {m.motivo}</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--ek-ink-faint)' }}>
                    {fechaEnTz(new Date(m.created_at), tz)} · {formatHoraEnTz(new Date(m.created_at), tz)} · {m.autor}
                  </div>
                </div>
                <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 14, minWidth: 42, textAlign: 'right', color: m.cantidad > 0 ? 'var(--ek-success)' : 'var(--ek-danger)' }}>
                  {m.cantidad > 0 ? '+' : ''}{m.cantidad}
                </div>
                <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: 13, minWidth: 50, textAlign: 'right', color: 'var(--ek-ink-muted)' }}>
                  = {m.saldo}
                </div>
              </div>
            ))}
          </div>
        )}
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
              className={tipo === v ? 'ek-cta' : 'ek-cta ek-cta--secondary'}
              style={{ flex: 1 }}
            >
              {l}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: 'var(--ek-ink-muted)', margin: '0 0 12px', lineHeight: 1.4 }}>
          {tipo === 'entrada'
            ? 'Llegó mercancía nueva (la compraste al proveedor). Suma al stock.'
            : tipo === 'merma'
              ? 'Se perdió, dañó, venció o robó. Resta del stock.'
              : 'Corrige el conteo a lo que hay físicamente — ni compra ni merma. Usa − para restar.'}
        </p>
        <label style={lbl}>{tipo === 'ajuste' ? 'Cantidad (con − para restar)' : 'Cantidad'}</label>
        <input className="ek-input" type="number" inputMode="numeric" value={cantidad} onChange={(e) => setCantidad(e.target.value)} placeholder="12" />
        <label style={lbl}>Motivo <span style={{ color: 'var(--ek-ink-faint)' }}>(opcional)</span></label>
        <input className="ek-input" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder={tipo === 'merma' ? 'Caducó' : 'Compra al proveedor'} />
        <div style={acciones}>
          <button className="ek-cta ek-cta--secondary" onClick={onClose}>Cancelar</button>
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