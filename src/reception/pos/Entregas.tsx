import { useCallback, useEffect, useState } from 'react';
import { PackageCheck } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import { useReceptionSucursal } from '../providers/ReceptionSucursalProvider';

/* ══════════════════════════════════════════════════════════════════════════
   COLA DE ENTREGAS — lo que el socio compró desde la app y hay que darle.
   ──────────────────────────────────────────────────────────────────────────
   Sin esto, el socio paga desde el móvil y nadie se entera de que hay que
   entregarle algo. Acá recepción ve qué, a quién y dónde, cuánto hace que
   espera, y lo marca entregado.
   ══════════════════════════════════════════════════════════════════════════ */

interface Entrega {
  id: string;
  cuando: string;
  tipo: 'recepcion' | 'tienda' | 'llevar';
  ubicacion: string | null;
  socio: string | null;
  items: string[];
}

const etiquetaTipo: Record<string, string> = {
  recepcion: 'Recoge en recepción',
  tienda: 'Recoge en la tienda',
  llevar: 'Se lo llevan'
};

function haceCuanto(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

export default function Entregas() {
  const toast = useToast();
  const { sucursalId } = useReceptionSucursal();
  const [entregas, setEntregas] = useState<Entrega[]>([]);
  const [cargando, setCargando] = useState(true);
  const [resolviendo, setResolviendo] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    let q = (supabase as any)
      .from('tienda_entregas')
      .select('id, created_at, tipo, ubicacion, usuario_id, pago_id')
      .eq('estado', 'pendiente')
      .order('created_at', { ascending: true });
    if (sucursalId) q = q.eq('sucursal_id', sucursalId);
    const { data: filas } = await q;
    const rows = (filas as any[]) ?? [];

    if (rows.length === 0) { setEntregas([]); setCargando(false); return; }

    const pagoIds = rows.map((r) => r.pago_id);
    const socioIds = [...new Set(rows.map((r) => r.usuario_id).filter(Boolean))];

    const { data: movs } = await (supabase as any)
      .from('producto_movimientos').select('pago_id, cantidad, producto_id').in('pago_id', pagoIds).eq('tipo', 'venta');
    const prodIds = [...new Set(((movs as any[]) ?? []).map((m) => m.producto_id))];
    const { data: prods } = prodIds.length
      ? await (supabase as any).from('productos').select('id, nombre').in('id', prodIds) : { data: [] };
    const nombreProd: Record<string, string> = {};
    for (const p of (prods as any[]) ?? []) nombreProd[p.id] = p.nombre;
    const { data: socios } = socioIds.length
      ? await supabase.from('usuarios').select('id, nombre').in('id', socioIds as string[]) : { data: [] };
    const nombreSocio: Record<string, string> = {};
    for (const u of (socios as any[]) ?? []) nombreSocio[u.id] = u.nombre;

    const itemsDe: Record<string, string[]> = {};
    for (const m of (movs as any[]) ?? []) (itemsDe[m.pago_id] ??= []).push(`${Math.abs(m.cantidad)}× ${nombreProd[m.producto_id] ?? 'Producto'}`);

    setEntregas(rows.map((r) => ({
      id: r.id, cuando: r.created_at, tipo: r.tipo, ubicacion: r.ubicacion,
      socio: r.usuario_id ? (nombreSocio[r.usuario_id] ?? 'Socio') : null,
      items: itemsDe[r.pago_id] ?? []
    })));
    setCargando(false);
  }, [sucursalId]);

  useEffect(() => { void cargar(); }, [cargar]);

  async function marcar(id: string) {
    setResolviendo(id);
    const { error } = await supabase.rpc('marcar_entregado' as never, { p_entrega_id: id } as never);
    setResolviendo(null);
    if (error) return toast.error('No se pudo: ' + error.message);
    toast.success('Entregado');
    void cargar();
  }

  if (cargando) return <p className="ek-body-muted">Cargando…</p>;

  if (entregas.length === 0) {
    return (
      <div className="ek-card" style={{ padding: 32, textAlign: 'center' }}>
        <PackageCheck size={30} style={{ color: 'var(--ek-ink-faint)' }} />
        <p className="ek-body-muted" style={{ marginTop: 10 }}>No hay nada pendiente de entregar.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {entregas.map((e) => (
        <div key={e.id} className="ek-card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{e.items.join(', ') || 'Compra'}</div>
            <div className="ek-body-muted" style={{ fontSize: 13, marginTop: 3 }}>
              {e.socio ?? 'Socio'} · {etiquetaTipo[e.tipo]}{e.ubicacion ? ` · ${e.ubicacion}` : ''}
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--ek-ink-faint)', whiteSpace: 'nowrap' }}>{haceCuanto(e.cuando)}</div>
          <button className="ek-cta" onClick={() => marcar(e.id)} disabled={resolviendo === e.id} style={{ minHeight: 40, padding: '0 18px' }}>
            {resolviendo === e.id ? '…' : 'Entregado'}
          </button>
        </div>
      ))}
    </div>
  );
}
