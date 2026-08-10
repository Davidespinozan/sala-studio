import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import { formatearMoneda } from '@shared/lib/dinero';

interface Cargo {
  id: string;
  socio: string;
  descripcion: string | null;
  monto_centavos: number;
}

// cargos_pendientes / sus RPCs aún no están en los tipos generados → cast.
const rpc = supabase.rpc.bind(supabase) as unknown as (
  name: string,
  args: Record<string, unknown>
) => Promise<{ data: unknown; error: { message: string } | null }>;

/**
 * "Por cobrar": los cargos pendientes (day passes, etc.) que se cobran cuando el
 * socio llega. No aparece si no hay ninguno. Al cobrar, nace el pago real y se
 * refresca la Caja (onCambio).
 */
export function PorCobrarCard({ tenantId, onCambio }: { tenantId: string; onCambio: () => void }) {
  const toast = useToast();
  const [cargos, setCargos] = useState<Cargo[]>([]);
  const [cargando, setCargando] = useState(true);

  const refetch = useCallback(async () => {
    const from = supabase.from.bind(supabase) as unknown as (t: string) => {
      select: (s: string) => {
        eq: (c: string, v: unknown) => {
          eq: (c: string, v: unknown) => {
            order: (c: string, o: { ascending: boolean }) => Promise<{ data: unknown[] | null }>;
          };
        };
      };
    };
    const { data } = await from('cargos_pendientes')
      .select('id, descripcion, monto_centavos, socio:usuarios!cargos_pendientes_usuario_id_fkey(nombre)')
      .eq('tenant_id', tenantId)
      .eq('estado', 'pendiente')
      .order('created_at', { ascending: true });
    setCargos(
      (data ?? []).map((row) => {
        const r = row as { id: string; descripcion: string | null; monto_centavos: number; socio?: { nombre?: string | null } | null };
        return { id: r.id, socio: r.socio?.nombre ?? '—', descripcion: r.descripcion, monto_centavos: r.monto_centavos };
      })
    );
    setCargando(false);
  }, [tenantId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  if (cargando || cargos.length === 0) return null;

  const total = cargos.reduce((s, c) => s + c.monto_centavos, 0);

  return (
    <section className="ek-card" style={{ padding: '20px', marginBottom: '20px', border: '1px solid var(--sala-primary)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
        <span className="ek-eyebrow ek-eyebrow--mustard" style={{ fontSize: '11px' }}>POR COBRAR</span>
        <strong style={{ fontSize: '16px', color: 'var(--ek-ink)' }}>{formatearMoneda(total)}</strong>
      </div>
      <div style={{ display: 'grid', gap: '10px' }}>
        {cargos.map((c) => (
          <CargoRow
            key={c.id}
            cargo={c}
            toast={toast}
            onDone={async () => { await refetch(); onCambio(); }}
          />
        ))}
      </div>
    </section>
  );
}

function CargoRow({
  cargo,
  toast,
  onDone
}: {
  cargo: Cargo;
  toast: ReturnType<typeof useToast>;
  onDone: () => Promise<void>;
}) {
  const [metodo, setMetodo] = useState<'efectivo' | 'tarjeta' | 'transferencia'>('efectivo');
  const [busy, setBusy] = useState(false);

  async function cobrar() {
    setBusy(true);
    const { error } = await rpc('cobrar_cargo_pendiente', { p_cargo_id: cargo.id, p_metodo: metodo });
    if (error) {
      setBusy(false);
      toast.error(error.message.replace(/^[A-Z_]+:\s*/, '') || 'No se pudo cobrar');
      return;
    }
    toast.success(`Cobrado ${formatearMoneda(cargo.monto_centavos)}.`);
    await onDone();
  }

  async function cancelar() {
    if (!confirm(`¿Cancelar el cargo de ${formatearMoneda(cargo.monto_centavos)} de ${cargo.socio}? No se cobrará.`)) return;
    setBusy(true);
    const { error } = await rpc('cancelar_cargo_pendiente', { p_cargo_id: cargo.id, p_motivo: null });
    if (error) {
      setBusy(false);
      toast.error(error.message.replace(/^[A-Z_]+:\s*/, '') || 'No se pudo cancelar');
      return;
    }
    toast.success('Cargo cancelado.');
    await onDone();
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: '150px' }}>
        <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: 'var(--ek-ink)' }}>
          {cargo.socio} · {formatearMoneda(cargo.monto_centavos)}
        </p>
        {cargo.descripcion && (
          <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--ek-ink-muted)' }}>{cargo.descripcion}</p>
        )}
      </div>
      <select
        value={metodo}
        onChange={(e) => setMetodo(e.target.value as 'efectivo' | 'tarjeta' | 'transferencia')}
        className="ek-input"
        style={{ width: 'auto', fontSize: '13px' }}
        disabled={busy}
      >
        <option value="efectivo">Efectivo</option>
        <option value="tarjeta">Tarjeta</option>
        <option value="transferencia">Transferencia</option>
      </select>
      <button type="button" onClick={cobrar} disabled={busy} className="ek-cta" style={{ fontSize: '13px' }}>
        {busy ? '…' : 'Cobrar'}
      </button>
      <button type="button" onClick={cancelar} disabled={busy} className="ek-cta ek-cta--secondary" style={{ fontSize: '13px' }}>
        Cancelar
      </button>
    </div>
  );
}