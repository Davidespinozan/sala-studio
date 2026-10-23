import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import { formatearMoneda } from '@shared/lib/dinero';
import { useOperationKey } from '@shared/lib/operationKey';

interface Cargo {
  id: string;
  socio: string;
  concepto: string;
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
export function PorCobrarCard({
  tenantId,
  sucursalId = null,
  puedeCancelar = true,
  onCambio
}: {
  tenantId: string;
  /** Solo los cargos de esta sede (Caja de recepción). null = todos. */
  sucursalId?: string | null;
  /** Cancelar un cargo (perdonar la deuda) es del dueño; recepción solo cobra. */
  puedeCancelar?: boolean;
  onCambio: () => void;
}) {
  const toast = useToast();
  const [cargos, setCargos] = useState<Cargo[]>([]);
  const [cargando, setCargando] = useState(true);

  const refetch = useCallback(async () => {
    type Builder = {
      eq: (c: string, v: unknown) => Builder;
      order: (c: string, o: { ascending: boolean }) => Promise<{ data: unknown[] | null }>;
    };
    const from = supabase.from.bind(supabase) as unknown as (t: string) => {
      select: (s: string) => Builder;
    };
    let q = from('cargos_pendientes')
      .select('id, concepto, descripcion, monto_centavos, socio:usuarios!cargos_pendientes_usuario_id_fkey(nombre)')
      .eq('tenant_id', tenantId)
      .eq('estado', 'pendiente');
    if (sucursalId) q = q.eq('sucursal_id', sucursalId);
    const { data } = await q.order('created_at', { ascending: true });
    setCargos(
      (data ?? []).map((row) => {
        const r = row as { id: string; concepto?: string | null; descripcion: string | null; monto_centavos: number; socio?: { nombre?: string | null } | null };
        return { id: r.id, socio: r.socio?.nombre ?? '—', concepto: r.concepto ?? 'otro', descripcion: r.descripcion, monto_centavos: r.monto_centavos };
      })
    );
    setCargando(false);
  }, [tenantId, sucursalId]);

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
            puedeCancelar={puedeCancelar}
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
  puedeCancelar,
  onDone
}: {
  cargo: Cargo;
  toast: ReturnType<typeof useToast>;
  puedeCancelar: boolean;
  onDone: () => Promise<void>;
}) {
  const [metodo, setMetodo] = useState<'efectivo' | 'tarjeta' | 'transferencia'>('efectivo');
  const [busy, setBusy] = useState(false);
  // Idempotencia: reintento tras respuesta perdida devuelve el mismo pago, no cobra dos veces.
  const operationKey = useOperationKey([cargo.id, metodo]);

  async function cobrar() {
    setBusy(true);
    const { error } = await rpc('cobrar_cargo_pendiente', { p_cargo_id: cargo.id, p_metodo: metodo, p_operation_key: operationKey });
    if (error) {
      setBusy(false);
      toast.error(error.message.replace(/^[A-Z_]+:\s*/, '') || 'No se pudo cobrar');
      return;
    }
    toast.success(`Cobrado ${formatearMoneda(cargo.monto_centavos)}.`);
    await onDone();
  }

  // Un cargo de PLAN es un plan "por cobrar" (nunca pagado): cancelarlo cancela
  // también el plan y sus reservas futuras. Antes solo desaparecía el cargo y el
  // socio se quedaba con el plan activo gratis (The Core, 22-oct-2026).
  const esPlan = cargo.concepto === 'plan';

  async function cancelar() {
    const aviso = esPlan
      ? `¿Cancelar el plan por cobrar de ${cargo.socio} (${formatearMoneda(cargo.monto_centavos)})? No se cobrará, su plan queda cancelado y se liberan sus reservas futuras.`
      : `¿Cancelar el cargo de ${formatearMoneda(cargo.monto_centavos)} de ${cargo.socio}? No se cobrará.`;
    if (!confirm(aviso)) return;
    setBusy(true);
    const { data, error } = await rpc('cancelar_cargo_pendiente', { p_cargo_id: cargo.id, p_motivo: null });
    if (error) {
      setBusy(false);
      toast.error(error.message.replace(/^[A-Z_]+:\s*/, '') || 'No se pudo cancelar');
      return;
    }
    const plan = (data as { plan?: { plan_cancelado?: boolean; reason?: string } } | null)?.plan;
    if (esPlan && plan?.plan_cancelado) toast.success('Cargo y plan cancelados. Sus reservas futuras quedaron liberadas.');
    else if (esPlan && plan?.reason === 'tiene_pagos') toast.info('Cargo cancelado. El plan se conservó porque ya tiene pagos registrados.');
    else toast.success('Cargo cancelado.');
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
      {/* Perdonar una deuda es del dueño; cancelar un plan por cobrar (nunca
          pagado) también lo puede hacer recepción: así no queda un plan gratis. */}
      {(puedeCancelar || esPlan) && (
        <button type="button" onClick={cancelar} disabled={busy} className="ek-cta ek-cta--secondary" style={{ fontSize: '13px' }}>
          {esPlan ? 'Cancelar plan' : 'Cancelar'}
        </button>
      )}
    </div>
  );
}