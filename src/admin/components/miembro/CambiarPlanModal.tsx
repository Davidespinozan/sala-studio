import { useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import { useTiersAdmin } from '@admin/hooks/useAdminData';

interface Props {
  usuarioId: string;
  nombreMiembro: string;
  tierActualSlug: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

export function CambiarPlanModal({
  usuarioId,
  nombreMiembro,
  tierActualSlug,
  onClose,
  onSaved
}: Props) {
  const toast = useToast();
  const { tiers, isLoading } = useTiersAdmin();
  const [selSlug, setSelSlug] = useState<string>(tierActualSlug ?? '');
  const [saving, setSaving] = useState(false);

  const tiersActivos = tiers.filter((t) => t.activo);

  async function handleSave() {
    setSaving(true);
    const nuevoTier = selSlug || null;
    const { error } = await supabase
      .from('usuarios')
      .update({ membresia_tier: nuevoTier })
      .eq('id', usuarioId);
    setSaving(false);
    if (error) {
      toast.error('No pudimos cambiar el plan. Probá de nuevo.');
      return;
    }
    toast.success(
      nuevoTier
        ? `Plan de ${nombreMiembro} actualizado.`
        : `Plan de ${nombreMiembro} removido.`
    );
    await onSaved();
    onClose();
  }

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
          Cambiar plan
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
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, marginBottom: '20px' }}>
          Elegí el plan que querés asignar. El cambio aplica inmediatamente.
        </p>

        {isLoading ? (
          <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)' }}>
            Cargando planes…
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
            {tiersActivos.map((t) => {
              const selected = selSlug === t.slug;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelSlug(t.slug)}
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
                    <p style={{ fontSize: '12px', color: 'var(--sala-text-secondary)', margin: 0, fontVariantNumeric: 'tabular-nums' }}>
                      ${(t.precio_centavos / 100).toLocaleString('es-MX')} {t.moneda}/{t.periodo}
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

            <button
              type="button"
              onClick={() => setSelSlug('')}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 16px',
                background: selSlug === '' ? 'var(--sala-bg)' : 'var(--sala-surface)',
                border: `1px dashed ${selSlug === '' ? 'var(--sala-border-strong)' : 'var(--sala-border)'}`,
                borderRadius: '12px',
                cursor: 'pointer',
                fontFamily: 'inherit',
                textAlign: 'left'
              }}
            >
              <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, fontStyle: 'italic' }}>
                Sin plan asignado (queda pendiente_pago)
              </p>
              <span style={{ fontSize: '14px', color: selSlug === '' ? 'var(--sala-text-primary)' : 'var(--sala-text-tertiary)', fontWeight: 700 }}>
                {selSlug === '' ? '●' : '○'}
              </span>
            </button>
          </div>
        )}

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
            onClick={handleSave}
            disabled={saving || selSlug === (tierActualSlug ?? '')}
            className="ek-cta"
            style={{ flex: 1 }}
          >
            {saving ? 'Guardando…' : 'Guardar cambio'}
          </button>
        </div>
      </div>
    </div>
  );
}
