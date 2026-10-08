import { useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import { formatearMoneda } from '@shared/lib/dinero';
import { useOperationKey } from '@shared/lib/operationKey';
import type { CargoPendiente } from '@shared/hooks/useCargosPendientes';

// cobrar_cargo_pendiente aún no está en los tipos generados → cast.
const rpc = supabase.rpc.bind(supabase) as unknown as (
  name: string,
  args: Record<string, unknown>
) => Promise<{ data: unknown; error: { message: string } | null }>;

type Metodo = 'efectivo' | 'tarjeta' | 'transferencia';

/**
 * Una fila "Por cobrar": monto + qué es + método + Cobrar. Cobra el cargo que ya
 * existe (nace el pago en la Caja y el cargo queda cobrado); NO toca clases ni
 * vigencia, que ya se dieron cuando se dejó pendiente.
 */
export function CargoPendienteRow({
  cargo,
  mostrarSocio = false,
  onCobrado
}: {
  cargo: CargoPendiente;
  /** En listas de varios socios (Hoy) se muestra el nombre; en la ficha no. */
  mostrarSocio?: boolean;
  onCobrado: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [metodo, setMetodo] = useState<Metodo>('efectivo');
  const [busy, setBusy] = useState(false);
  // Idempotencia: reintento tras respuesta perdida devuelve el mismo pago, no cobra dos veces.
  const operationKey = useOperationKey([cargo.id, metodo]);

  async function cobrar() {
    setBusy(true);
    const { error } = await rpc('cobrar_cargo_pendiente', {
      p_cargo_id: cargo.id,
      p_metodo: metodo,
      p_operation_key: operationKey
    });
    if (error) {
      setBusy(false);
      toast.error(error.message.replace(/^[A-Z_]+:\s*/, '') || 'No se pudo cobrar');
      return;
    }
    toast.success(`Cobrado ${formatearMoneda(cargo.monto_centavos)}.`);
    await onCobrado();
  }

  const socio = cargo.socio_nombre?.trim() || cargo.socio_email || '—';
  const dejado = new Date(cargo.created_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: '150px' }}>
        <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: 'var(--sala-text-primary)' }}>
          {mostrarSocio ? `${socio} · ` : ''}{formatearMoneda(cargo.monto_centavos)}
        </p>
        <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--sala-text-tertiary)' }}>
          {cargo.descripcion ?? cargo.concepto} · pendiente desde el {dejado}
        </p>
      </div>
      <select
        value={metodo}
        onChange={(e) => setMetodo(e.target.value as Metodo)}
        className="ek-input"
        style={{ width: 'auto', fontSize: '13px' }}
        disabled={busy}
        aria-label="Método de pago del pendiente"
      >
        <option value="efectivo">Efectivo</option>
        <option value="tarjeta">Tarjeta</option>
        <option value="transferencia">Transferencia</option>
      </select>
      <button type="button" onClick={cobrar} disabled={busy} className="ek-cta" style={{ fontSize: '13px' }}>
        {busy ? 'Cobrando…' : `Cobrar ${formatearMoneda(cargo.monto_centavos)}`}
      </button>
    </div>
  );
}

/**
 * Aviso dentro de los modales que activan/renuevan un plan: si el socio ya tiene
 * algo "Por cobrar", lo más probable es que vino a PAGAR eso, no a comprar otra
 * vez. Ofrece cobrarlo ahí mismo y exige marcar "es una compra nueva" para
 * seguir con la renovación (si no, se duplican clases y vigencia).
 */
export function AvisoCargoPendiente({
  cargos,
  esCompraNueva,
  onEsCompraNuevaChange,
  onCobrado
}: {
  cargos: CargoPendiente[];
  esCompraNueva: boolean;
  onEsCompraNuevaChange: (v: boolean) => void;
  onCobrado: () => Promise<void> | void;
}) {
  if (cargos.length === 0) return null;
  return (
    <div
      role="alert"
      style={{
        border: '1px solid var(--sala-primary)',
        borderRadius: 'var(--ek-r-md)',
        padding: '12px 14px',
        marginBottom: '14px',
        background: 'color-mix(in srgb, var(--sala-primary) 6%, var(--sala-surface))'
      }}
    >
      <p style={{ margin: '0 0 4px', fontSize: '13px', fontWeight: 700, color: 'var(--sala-text-primary)' }}>
        Este socio tiene un pago pendiente
      </p>
      <p style={{ margin: '0 0 10px', fontSize: '12px', lineHeight: 1.45, color: 'var(--sala-text-secondary)' }}>
        Si vino a pagarlo, cóbralo aquí. <strong>No lo renueves</strong>: renovar le suma otras clases y más días.
      </p>
      <div style={{ display: 'grid', gap: '10px', marginBottom: '10px' }}>
        {cargos.map((c) => (
          <CargoPendienteRow key={c.id} cargo={c} onCobrado={onCobrado} />
        ))}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', cursor: 'pointer', color: 'var(--sala-text-secondary)' }}>
        <input type="checkbox" checked={esCompraNueva} onChange={(e) => onEsCompraNuevaChange(e.target.checked)} />
        No, es una compra nueva (aparte del pendiente)
      </label>
    </div>
  );
}
