import { useMemo, useState } from 'react';
import { Circle, CircleDot } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import {
  useTiersAdmin,
  gestionarMembresiaSocio,
  recepcionCancelarMembresia
} from '@admin/hooks/useAdminData';
import { useMembresiaActual } from '@member/hooks/useMembresiaActual';
import {
  previewGestionarMembresia,
  describirPreview,
  type TipoTier
} from '@admin/lib/membresiaPreview';

interface Props {
  usuarioId: string;
  nombreMiembro: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

/**
 * Modal para que staff (admin/recepción) gestione la membresía de un socio.
 * Reemplaza al viejo CambiarPlanModal (que solo movía `usuarios.membresia_tier`
 * y dejaba `membresias` desincronizado). Acá invocamos el RPC
 * gestionar_membresia_socio (Fase 4) que hace todo atómico.
 *
 * Flow:
 *   1. Trae la membresía actual del socio + los tiers activos del tenant.
 *   2. El admin elige un tier de la lista.
 *   3. Mostramos PREVIEW del efecto (alta / renovación / cambio de tipo).
 *   4. Elige cómo se cobró (efectivo/transferencia/cortesía).
 *   5. Confirmar → RPC + toast + refetch del MiembroDetalle.
 *
 * El cobro SÍ se registra: efectivo/transferencia dejan el pago en la Caja por el
 * precio del plan (vía gestionar_membresia_socio). Cortesía activa sin cobrar.
 */
export function GestionarMembresiaModal({
  usuarioId,
  nombreMiembro,
  onClose,
  onSaved
}: Props) {
  const toast = useToast();
  const { tiers, isLoading: loadingTiers } = useTiersAdmin();
  const { membresia, isLoading: loadingMem } = useMembresiaActual(usuarioId);
  const [selTierId, setSelTierId] = useState<string>('');
  // Cómo se cobró la renovación/cambio: efectivo/transferencia registran el pago
  // en la Caja (por el precio del plan); cortesía activa sin cobrar. Antes esto no
  // existía y el cobro "se gestionaba afuera" → el dinero de una renovación hecha
  // desde admin no quedaba registrado.
  const [formaPago, setFormaPago] = useState<'efectivo' | 'tarjeta' | 'transferencia' | 'cortesia' | 'pendiente'>('efectivo');
  const [saving, setSaving] = useState(false);
  // Baja de membresía (recepcion_cancelar_membresia).
  const [showBaja, setShowBaja] = useState(false);
  const [motivoBaja, setMotivoBaja] = useState('');
  const [bajando, setBajando] = useState(false);

  const tiersActivos = useMemo(() => tiers.filter((t) => t.activo), [tiers]);

  const tierElegido = useMemo(
    () => tiersActivos.find((t) => t.id === selTierId) ?? null,
    [tiersActivos, selTierId]
  );

  // Preview del efecto del cambio. Recalcula cada vez que cambia la selección.
  const preview = useMemo(() => {
    if (!tierElegido) return null;
    return previewGestionarMembresia(
      membresia
        ? {
            tier_tipo: membresia.tier_tipo,
            periodo_actual_fin: membresia.periodo_actual_fin,
            creditos_restantes: membresia.creditos_restantes
          }
        : null,
      {
        tipo: tierElegido.tipo as TipoTier,
        duracion_dias: tierElegido.duracion_dias,
        clases_incluidas: tierElegido.clases_incluidas
      }
    );
  }, [tierElegido, membresia]);

  const descripcion = useMemo(() => {
    if (!preview || !tierElegido) return null;
    return describirPreview(preview, {
      tipo: tierElegido.tipo as TipoTier,
      duracion_dias: tierElegido.duracion_dias,
      clases_incluidas: tierElegido.clases_incluidas
    });
  }, [preview, tierElegido]);

  async function handleConfirm() {
    if (!selTierId) return;
    setSaving(true);
    const { data, error } = await gestionarMembresiaSocio({
      usuario_id: usuarioId,
      tier_id: selTierId,
      // La pantalla YA le mostró al admin "el socio pierde N clases" (ver preview).
      // Confirmamos esa pérdida contra la base, que sin esto rechaza el cambio.
      confirmar_perdida: (preview?.creditosPerdidos ?? 0) > 0,
      // Registra el pago en la Caja si se cobró; cortesía/pendiente → null (no
      // cobra ahora). El monto lo pone el RPC con el precio de lista del plan.
      metodo_pago: formaPago === 'cortesia' || formaPago === 'pendiente' ? null : formaPago
    });
    if (error || !data) {
      setSaving(false);
      toast.error(error ?? 'No pudimos actualizar la membresía.');
      return;
    }

    // Pendiente: dejar el cobro "por cobrar" (se cobra en la Caja al llegar).
    if (formaPago === 'pendiente' && tierElegido && (tierElegido.precio_centavos ?? 0) > 0) {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        name: string,
        args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
      const { error: cargoErr } = await rpc('registrar_cargo_pendiente', {
        p_usuario_id: usuarioId,
        p_monto_centavos: tierElegido.precio_centavos,
        p_concepto: 'plan',
        p_descripcion: tierElegido.nombre
      });
      if (cargoErr) {
        setSaving(false);
        toast.error('El plan se activó, pero no se pudo dejar el pendiente: ' + cargoErr.message);
        return;
      }
    }
    setSaving(false);
    toast.success(
      data.modo === 'alta'
        ? `Membresía creada para ${nombreMiembro}.`
        : data.modo === 'cambio_de_tipo'
          ? `Plan de ${nombreMiembro} cambiado.`
          : `Membresía de ${nombreMiembro} renovada.`
    );
    await onSaved();
    onClose();
  }

  async function handleBaja() {
    if (motivoBaja.trim().length < 3) return;
    setBajando(true);
    const { error } = await recepcionCancelarMembresia({
      usuario_id: usuarioId,
      motivo: motivoBaja.trim()
    });
    setBajando(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(`Membresía de ${nombreMiembro} dada de baja.`);
    await onSaved();
    onClose();
  }

  const formateoMembresiaActual = useMemo(() => {
    if (loadingMem) return 'Cargando…';
    if (!membresia) return 'Sin membresía activa.';
    const fin = membresia.periodo_actual_fin
      ? new Date(membresia.periodo_actual_fin).toLocaleDateString('es-MX', {
          day: 'numeric',
          month: 'long',
          year: 'numeric'
        })
      : null;
    if (membresia.tier_tipo === 'tiempo') {
      return fin
        ? `${membresia.tier_nombre} (por tiempo) · vence el ${fin}`
        : `${membresia.tier_nombre} (por tiempo)`;
    }
    if (membresia.tier_tipo === 'creditos') {
      const saldo = membresia.creditos_restantes ?? 0;
      return `${membresia.tier_nombre} (créditos) · ${saldo} clase${saldo === 1 ? '' : 's'} restante${saldo === 1 ? '' : 's'}`;
    }
    // hibrido
    const saldo = membresia.creditos_restantes ?? 0;
    return fin
      ? `${membresia.tier_nombre} (híbrido) · ${saldo} clase${saldo === 1 ? '' : 's'} hasta ${fin}`
      : `${membresia.tier_nombre} (híbrido) · ${saldo} clase${saldo === 1 ? '' : 's'}`;
  }, [membresia, loadingMem]);

  return (
    <div className="ek-modal-backdrop" onClick={onClose}>
      <div className="ek-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ek-modal-handle" />
        <p
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--sala-primary)',
            margin: 0,
            marginBottom: '8px'
          }}
        >
          Gestionar membresía
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: 'var(--sala-text-primary)',
            margin: 0,
            marginBottom: '6px'
          }}
        >
          {nombreMiembro}
        </h3>

        {/* Estado actual */}
        <div
          style={{
            padding: '12px 14px',
            background: 'var(--sala-surface)',
            border: '1px solid var(--sala-border)',
            borderRadius: '10px',
            marginTop: '12px',
            marginBottom: '20px'
          }}
        >
          <p
            style={{
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--sala-text-tertiary)',
              margin: 0,
              marginBottom: '4px'
            }}
          >
            Estado actual
          </p>
          <p style={{ fontSize: '13px', color: 'var(--sala-text-primary)', margin: 0 }}>
            {formateoMembresiaActual}
          </p>
        </div>

        {/* Selector de tier */}
        {loadingTiers ? (
          <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)' }}>Cargando planes…</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
            {tiersActivos.map((t) => {
              const selected = selTierId === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelTierId(t.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '14px 16px',
                    background: selected ? 'var(--sala-primary-light)' : 'var(--sala-surface)',
                    border: `1px solid ${selected ? 'var(--sala-primary)' : 'var(--sala-border)'}`,
                    borderRadius: '12px',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    textAlign: 'left'
                  }}
                >
                  <div>
                    <p
                      style={{
                        fontSize: '14px',
                        fontWeight: 600,
                        color: selected ? 'var(--sala-primary)' : 'var(--sala-text-primary)',
                        margin: 0,
                        marginBottom: '2px'
                      }}
                    >
                      {t.nombre}
                    </p>
                    <p
                      style={{
                        fontSize: '12px',
                        color: 'var(--sala-text-secondary)',
                        margin: 0,
                        fontVariantNumeric: 'tabular-nums'
                      }}
                    >
                      {tierResumen(t)}
                    </p>
                  </div>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      color: selected ? 'var(--sala-primary)' : 'var(--sala-text-tertiary)'
                    }}
                  >
                    {selected
                      ? <CircleDot size={18} strokeWidth={2.25} />
                      : <Circle size={18} strokeWidth={2.25} />}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Preview del efecto */}
        {descripcion && preview && (
          <div
            style={{
              padding: '14px 16px',
              background:
                preview.modo === 'cambio_de_tipo' && (descripcion.advertencia ?? null)
                  ? 'var(--sala-warning-bg)'
                  : 'var(--sala-success-bg)',
              border: `1px solid ${
                preview.modo === 'cambio_de_tipo' && descripcion.advertencia
                  ? 'var(--sala-warning-glow)'
                  : 'var(--sala-success)'
              }`,
              borderRadius: '12px',
              marginBottom: '20px'
            }}
          >
            <p
              style={{
                fontSize: '11px',
                fontWeight: 700,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color:
                  preview.modo === 'cambio_de_tipo' && descripcion.advertencia
                    ? 'var(--sala-warning)'
                    : 'var(--sala-success)',
                margin: 0,
                marginBottom: '6px'
              }}
            >
              {descripcion.titulo}
            </p>
            <p
              style={{
                fontSize: '13.5px',
                lineHeight: 1.5,
                color: 'var(--sala-text-primary)',
                margin: 0
              }}
            >
              {descripcion.detalle}
            </p>
            {descripcion.advertencia && (
              <p
                style={{
                  fontSize: '12.5px',
                  lineHeight: 1.45,
                  color: 'var(--sala-warning)',
                  margin: '8px 0 0',
                  fontWeight: 600
                }}
              >
                {descripcion.advertencia}
              </p>
            )}
          </div>
        )}

        {/* Cobro: registra el pago en la Caja, igual que recepción. */}
        {selTierId && (
          <div style={{ marginBottom: '12px' }}>
            <label
              htmlFor="gm-forma-pago"
              style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, color: 'var(--sala-text-primary)', marginBottom: '6px' }}
            >
              Cobro
            </label>
            <select
              id="gm-forma-pago"
              value={formaPago}
              onChange={(e) => setFormaPago(e.target.value as 'efectivo' | 'tarjeta' | 'transferencia' | 'cortesia' | 'pendiente')}
              className="ek-input"
              disabled={saving}
            >
              <option value="efectivo">Pagó en efectivo</option>
              <option value="tarjeta">Pagó con terminal</option>
              <option value="transferencia">Pagó por transferencia</option>
              <option value="cortesia">Cortesía / gratis (sin cargo)</option>
              <option value="pendiente">Pendiente (pagar al llegar)</option>
            </select>
            {formaPago === 'pendiente' && (
              <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px', lineHeight: 1.45 }}>
                Se activa ya; el cobro queda <strong>“Por cobrar”</strong> en la Caja y se cobra cuando llegue. No cuenta como ingreso ni cortesía hasta entonces.
              </p>
            )}
            <p style={{ fontSize: '11.5px', color: 'var(--sala-text-tertiary)', margin: '6px 0 0', lineHeight: 1.45 }}>
              Efectivo o transferencia registran el pago en la Caja por el precio del plan.
              Cortesía activa sin cobrar.
            </p>
          </div>
        )}

        {/* Acciones */}
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={saving || !selTierId}
            className="ek-cta"
            style={{ flex: 1 }}
          >
            {saving ? 'Guardando…' : 'Confirmar'}
          </button>
        </div>
        <p
          style={{
            fontSize: '11.5px',
            color: 'var(--sala-text-tertiary)',
            margin: '10px 0 0',
            textAlign: 'center'
          }}
        >
          Registra el pago en la Caja según el cobro elegido (o cortesía si no cobraste).
        </p>

        {/* Baja de membresía — solo si tiene una activa. */}
        {membresia && !showBaja && (
          <button
            type="button"
            onClick={() => setShowBaja(true)}
            disabled={saving}
            style={{
              marginTop: '16px',
              width: '100%',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--sala-error)'
            }}
          >
            Dar de baja la membresía
          </button>
        )}

        {membresia && showBaja && (
          <div
            style={{
              marginTop: '16px',
              padding: '14px',
              border: '1px solid var(--sala-error-glow, var(--sala-border))',
              background: 'var(--sala-error-bg)',
              borderRadius: '12px'
            }}
          >
            <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--sala-text-primary)', margin: '0 0 8px' }}>
              Dar de baja la membresía de {nombreMiembro}
            </p>
            <p style={{ fontSize: '12px', color: 'var(--sala-text-secondary)', margin: '0 0 10px', lineHeight: 1.45 }}>
              Su acceso queda bloqueado al instante. No borra el historial. Indica el motivo:
            </p>
            <input
              type="text"
              value={motivoBaja}
              onChange={(e) => setMotivoBaja(e.target.value)}
              placeholder="Motivo de la baja"
              className="ek-input"
              style={{ marginBottom: '10px' }}
            />
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                type="button"
                onClick={() => { setShowBaja(false); setMotivoBaja(''); }}
                disabled={bajando}
                className="ek-cta ek-cta--secondary"
                style={{ flex: 1 }}
              >
                Volver
              </button>
              <button
                type="button"
                onClick={handleBaja}
                disabled={bajando || motivoBaja.trim().length < 3}
                className="ek-cta"
                style={{ flex: 1, background: 'var(--sala-error)', borderColor: 'var(--sala-error)' }}
              >
                {bajando ? 'Dando de baja…' : 'Confirmar baja'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Resumen breve del tier para la lista (precio + tipo). */
function tierResumen(t: {
  precio_centavos: number;
  moneda: string;
  periodo: string;
  tipo: string;
  duracion_dias: number | null;
  clases_incluidas: number | null;
}): string {
  const precio = `$${(t.precio_centavos / 100).toLocaleString('es-MX')} ${t.moneda}`;
  if (t.tipo === 'tiempo') {
    return `${precio} · ${t.duracion_dias ?? '?'} días`;
  }
  if (t.tipo === 'creditos') {
    return `${precio} · ${t.clases_incluidas ?? '?'} clases`;
  }
  // hibrido
  return `${precio} · ${t.clases_incluidas ?? '?'} clases en ${t.duracion_dias ?? '?'} días`;
}
