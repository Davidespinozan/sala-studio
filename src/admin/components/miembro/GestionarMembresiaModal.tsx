import { useMemo, useState } from 'react';
import { useToast } from '@shared/hooks/useToast';
import {
  useTiersAdmin,
  gestionarMembresiaSocio
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
 *   4. Confirmar → RPC + toast + refetch del MiembroDetalle.
 *
 * Sin botón de pago — el cobro se gestiona afuera (efectivo/Stripe vendrá luego).
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
  const [saving, setSaving] = useState(false);

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
      tier_id: selTierId
    });
    setSaving(false);
    if (error || !data) {
      toast.error(error ?? 'No pudimos actualizar la membresía.');
      return;
    }
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
                      fontSize: '14px',
                      color: selected ? 'var(--sala-primary)' : 'var(--sala-text-tertiary)',
                      fontWeight: 700
                    }}
                  >
                    {selected ? '●' : '○'}
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
                  ? 'rgba(200, 148, 31, 0.3)'
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
          El cobro se gestiona aparte. Esta acción solo actualiza la membresía.
        </p>
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
