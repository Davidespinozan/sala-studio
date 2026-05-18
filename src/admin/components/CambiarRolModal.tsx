import { useEffect, useState } from 'react';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { adminUpdateRole } from '../hooks/useAdminData';
import { canModifyTeamMember } from '../lib/crudHelpers';

type Rol = 'admin' | 'recepcionista';

interface Props {
  usuarioId: string;
  nombre: string;
  rolActual: Rol;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

export default function CambiarRolModal({
  usuarioId,
  nombre,
  rolActual,
  onClose,
  onSaved
}: Props) {
  const tenant = useTenant();
  const { usuario: currentUser } = useAuth();
  const toast = useToast();

  const [nuevoRol, setNuevoRol] = useState<Rol>(rolActual);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const sinCambios = nuevoRol === rolActual;
  const cambiandoAdminARecepcionista =
    rolActual === 'admin' && nuevoRol === 'recepcionista';

  async function handleSave() {
    if (!currentUser) return;
    setSubmitting(true);
    setError(null);

    // Validar antes: auto-modificación + último admin
    if (cambiandoAdminARecepcionista) {
      const check = await canModifyTeamMember(
        usuarioId,
        currentUser.id,
        'admin',
        'change-role-to-recepcionista',
        tenant.id
      );
      if (!check.canModify) {
        setError(check.reason ?? 'No se puede cambiar el rol.');
        setSubmitting(false);
        return;
      }
    }

    if (usuarioId === currentUser.id) {
      setError('No puedes cambiar tu propio rol. Pídele a otro admin que lo haga.');
      setSubmitting(false);
      return;
    }

    const res = await adminUpdateRole({ usuario_id: usuarioId, rol: nuevoRol });
    if (!res.success) {
      setError('No se pudo actualizar el rol.');
      setSubmitting(false);
      return;
    }

    toast.success(`Rol actualizado a ${nuevoRol === 'admin' ? 'Administrador' : 'Recepcionista'}.`);
    setSubmitting(false);
    await onSaved();
    onClose();
  }

  return (
    <div
      onClick={() => !submitting && onClose()}
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        animation: 'ek-fade-in 0.18s ease'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-card)',
          maxWidth: '500px',
          width: '100%',
          padding: '28px',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '6px' }}>
          CAMBIAR ROL
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            margin: 0,
            marginBottom: '8px'
          }}
        >
          Cambiar rol de {nombre}
        </h3>
        <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '20px' }}>
          Rol actual:{' '}
          <strong style={{ color: 'var(--ek-ink)' }}>
            {rolActual === 'admin' ? 'Administrador' : 'Recepcionista'}
          </strong>
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
          {(
            [
              { value: 'admin' as const, label: 'Administrador' },
              { value: 'recepcionista' as const, label: 'Recepcionista' }
            ]
          ).map((opt) => (
            <label
              key={opt.value}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '12px',
                border: `0.5px solid ${nuevoRol === opt.value ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
                background:
                  nuevoRol === opt.value ? 'var(--ek-mustard-soft)' : 'var(--ek-bg-elevated)',
                borderRadius: 'var(--ek-r-md)',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 600,
                color: nuevoRol === opt.value ? 'var(--ek-mustard)' : 'var(--ek-ink)'
              }}
            >
              <input
                type="radio"
                name="nuevo-rol"
                value={opt.value}
                checked={nuevoRol === opt.value}
                onChange={() => setNuevoRol(opt.value)}
                style={{ accentColor: 'var(--ek-mustard)' }}
              />
              {opt.label}
            </label>
          ))}
        </div>

        {nuevoRol === 'admin' && rolActual !== 'admin' && (
          <p
            style={{
              fontSize: '12px',
              color: 'var(--ek-mustard)',
              background: 'var(--ek-mustard-soft)',
              padding: '10px 12px',
              borderRadius: 'var(--ek-r-sm)',
              margin: 0,
              marginBottom: '16px',
              lineHeight: 1.5
            }}
          >
            ⚠️ Cambiar a Administrador le dará acceso completo al sistema, incluyendo gestión
            de equipo y reglas de negocio.
          </p>
        )}

        {error && (
          <p className="ek-error-text" style={{ marginBottom: '12px' }}>
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={submitting || sinCambios}
            className="ek-cta"
            style={{ flex: 1 }}
          >
            {submitting ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>
  );
}
