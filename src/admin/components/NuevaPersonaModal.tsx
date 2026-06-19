import { useEffect, useState } from 'react';
import {
  adminCreateUser,
  gestionarMembresiaSocio,
  useTiersAdmin
} from '../hooks/useAdminData';
import { useSucursal } from '../providers/SucursalProvider';

type Rol = 'miembro' | 'recepcionista' | 'staff' | 'admin';
type FormaActivacion = 'efectivo' | 'transferencia' | 'cortesia';

// Asignar un plan activa al miembro (gestionar_membresia_socio pasa el status a
// 'activo'). Acá NO se cobra plata — solo se registra CÓMO se activó, en el
// motivo del movimiento de membresía.
const MOTIVO_ALTA: Record<FormaActivacion, string> = {
  efectivo: 'Alta con pago en efectivo',
  transferencia: 'Alta con pago por transferencia',
  cortesia: 'Alta de cortesía (sin cargo)',
};

interface Props {
  onClose: () => void;
  onCreated: () => Promise<void>;
}

export function NuevaPersonaModal({ onClose, onCreated }: Props) {
  const { tiers, isLoading: loadingTiers } = useTiersAdmin();
  const { sucursales, sucursalId: adminSucursalId, multisede } = useSucursal();
  const [email, setEmail] = useState('');
  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [password, setPassword] = useState('');
  const [rol, setRol] = useState<Rol>('miembro');
  // Sede de la persona (miembro/recepción en multisede). Default = la sede
  // activa del admin; el trigger de BD igual la rellena si quedara vacía.
  const [sucursalId, setSucursalId] = useState('');
  useEffect(() => {
    if (!sucursalId && adminSucursalId) setSucursalId(adminSucursalId);
  }, [adminSucursalId, sucursalId]);
  const pideSucursal = multisede && rol !== 'admin';
  // tier_id (uuid) o '' para "sin plan". Antes era slug hardcoded — ahora se
  // resuelve desde useTiersAdmin, así soporta tiers custom del tenant.
  const [tierId, setTierId] = useState<string>('');
  const [formaActivacion, setFormaActivacion] = useState<FormaActivacion>('efectivo');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ email: string; password: string; rol: string; warning?: string } | null>(null);
  const [needsAdminConfirm, setNeedsAdminConfirm] = useState(false);

  const tiersActivos = tiers.filter((t) => t.activo);

  function generarPassword() {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
    setPassword(out);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (rol === 'admin' && !needsAdminConfirm) {
      setNeedsAdminConfirm(true);
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await adminCreateUser({
        email: email.trim(),
        password,
        nombre: nombre.trim(),
        telefono: telefono.trim() || undefined,
        rol,
        // Pasamos null: el "atajo viejo" de setear usuarios.membresia_tier sin
        // crear fila en membresias dejaba al socio bloqueado por SIN_MEMBRESIA.
        // Si se eligió tier, la membresía la crea el RPC en el paso siguiente.
        membresia_tier: null,
        sucursal_id: pideSucursal ? sucursalId || null : null
      });

      // Si es miembro Y se eligió un tier, alta de membresía vía RPC. Eso
      // crea la fila en `membresias`, sincroniza `usuarios.membresia_tier`,
      // y pasa el status de pendiente_pago a activo.
      if (rol === 'miembro' && tierId) {
        const { error: memErr } = await gestionarMembresiaSocio({
          usuario_id: res.user.id,
          tier_id: tierId,
          motivo: MOTIVO_ALTA[formaActivacion]
        });
        if (memErr) {
          // El usuario YA está creado (auth + fila). Solo falló la membresía.
          // Lo tratamos como ÉXITO PARCIAL: mostramos las credenciales (así el
          // admin sabe que existe y no reintenta con el mismo email → "ya existe")
          // + un aviso para cargar el plan desde el perfil. NO es un error total.
          setSuccess({
            email: res.user.email,
            password: res.user.password,
            rol: res.user.rol,
            warning:
              `La cuenta se creó, pero no se pudo asignar el plan: ${memErr}. ` +
              `Asignalo desde el perfil de la persona (Miembros → su ficha).`
          });
          setSubmitting(false);
          return;
        }
      }

      setSuccess({
        email: res.user.email,
        password: res.user.password,
        rol: res.user.rol
      });
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos crear el usuario. Prueba de nuevo.');
      setSubmitting(false);
      setNeedsAdminConfirm(false);
    }
  }

  if (success) {
    return (
      <div className="adm-modal-backdrop" onClick={async () => { await onCreated(); }}>
        <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
          <p className="ek-eyebrow" style={{ color: 'var(--ek-success)' }}>CUENTA CREADA</p>
          <h3 className="ek-h3">Comparte estas credenciales</h3>

          <p style={{ color: 'var(--ek-ink-muted)', fontSize: '0.9375rem' }}>
            Cuenta lista para usar. Envíalas por WhatsApp o en persona.
            El usuario puede cambiar la password después en su perfil.
          </p>

          {success.warning && (
            <div
              role="alert"
              style={{
                background: 'var(--ek-mustard-soft, var(--ek-cream-warm))',
                border: '1px solid var(--sala-warning-glow, var(--ek-mustard))',
                color: 'var(--ek-ink)',
                borderRadius: 'var(--ek-r-md)',
                padding: '10px 12px',
                fontSize: '0.875rem',
                lineHeight: 1.45,
              }}
            >
              ⚠️ {success.warning}
            </div>
          )}

          <div className="ek-card" style={{ background: 'var(--ek-cream-warm)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.9375rem' }}>
              <div>
                <div className="adm-info-label">Email</div>
                <code style={{ fontFamily: 'var(--ek-font-mono)', userSelect: 'all' }}>{success.email}</code>
              </div>
              <div>
                <div className="adm-info-label">Password</div>
                <code style={{ fontFamily: 'var(--ek-font-mono)', userSelect: 'all', background: 'var(--ek-cream)', padding: '4px 8px', borderRadius: '4px' }}>
                  {success.password}
                </code>
              </div>
              <div>
                <div className="adm-info-label">Rol</div>
                <code style={{ fontFamily: 'var(--ek-font-mono)' }}>{success.rol}</code>
              </div>
            </div>
          </div>

          <button onClick={async () => { await onCreated(); }} className="ek-cta ek-cta--full">
            Listo
          </button>
        </div>
      </div>
    );
  }

  if (needsAdminConfirm) {
    return (
      <div className="adm-modal-backdrop" onClick={() => !submitting && setNeedsAdminConfirm(false)}>
        <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
          <p className="ek-eyebrow" style={{ color: 'var(--ek-danger)' }}>CONFIRMAR PROMOCIÓN A ADMIN</p>
          <h3 className="ek-h3">Esta persona tendrá acceso total</h3>
          <p style={{ color: 'var(--ek-ink-muted)', fontSize: '0.9375rem' }}>
            <strong>{nombre}</strong> ({email}) podrá ver y modificar TODO en SALA:
            crear/eliminar usuarios, cambiar precios, ver datos privados, cancelar reservas, etc.
            <br /><br />
            ¿Estás seguro?
          </p>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={() => setNeedsAdminConfirm(false)}
              disabled={submitting}
              className="ek-cta ek-cta--secondary"
              style={{ flex: 1 }}
            >
              Cancelar
            </button>
            <button
              onClick={handleSubmit as any}
              disabled={submitting}
              className="ek-cta"
              style={{ flex: 1, background: 'var(--ek-danger)' }}
            >
              {submitting ? 'Creando…' : 'Sí, crear admin'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="adm-modal-backdrop" onClick={() => !submitting && onClose()}>
      <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
        <p className="ek-eyebrow">NUEVA PERSONA</p>
        <h3 className="ek-h3" style={{ marginBottom: '0.5rem' }}>Crear cuenta</h3>

        <form onSubmit={handleSubmit} className="ek-stack-md">
          <div className="ek-form-field">
            <label className="ek-label" htmlFor="np-rol">Rol</label>
            <select
              id="np-rol"
              value={rol}
              onChange={(e) => setRol(e.target.value as Rol)}
              className="ek-input"
              required
            >
              <option value="miembro">Miembro (cliente que paga membresía)</option>
              <option value="recepcionista">Recepción (escanea QR en mostrador)</option>
              {/* 'staff' desactivado: rol a medias (permisos parciales sin UI propia).
                  Se reintroduce cuando se diseñe el tier limitado. */}
              <option value="admin">Admin (acceso total al negocio)</option>
            </select>
          </div>

          {pideSucursal && (
            <div className="ek-form-field">
              <label className="ek-label" htmlFor="np-sucursal">Sede</label>
              <select
                id="np-sucursal"
                value={sucursalId}
                onChange={(e) => setSucursalId(e.target.value)}
                className="ek-input"
              >
                {sucursales.map((s) => (
                  <option key={s.id} value={s.id}>{s.nombre}</option>
                ))}
              </select>
              <p className="ek-helper-text">
                {rol === 'recepcionista'
                  ? 'La recepción opera solo en esta sede.'
                  : 'Sede donde se inscribe. Su plan define si entrena solo aquí o en todas.'}
              </p>
            </div>
          )}

          {rol === 'miembro' && (
            <div className="ek-form-field">
              <label className="ek-label" htmlFor="np-tier">Plan inicial (opcional)</label>
              <select
                id="np-tier"
                value={tierId}
                onChange={(e) => setTierId(e.target.value)}
                className="ek-input"
                disabled={loadingTiers}
              >
                <option value="">— sin plan asignado —</option>
                {tiersActivos.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.nombre}
                  </option>
                ))}
              </select>
              <p className="ek-helper-text">
                Con plan, el miembro queda <strong>activo</strong> y puede entrar enseguida.
                Sin plan, queda en pendiente_pago hasta que lo actives desde su perfil.
              </p>
            </div>
          )}

          {rol === 'miembro' && tierId && (
            <div className="ek-form-field">
              <label className="ek-label" htmlFor="np-activacion">Activación</label>
              <select
                id="np-activacion"
                value={formaActivacion}
                onChange={(e) => setFormaActivacion(e.target.value as FormaActivacion)}
                className="ek-input"
              >
                <option value="efectivo">Activar — pagó en efectivo</option>
                <option value="transferencia">Activar — pagó por transferencia</option>
                <option value="cortesia">Cortesía / gratis (sin cargo)</option>
              </select>
              <p className="ek-helper-text">
                Queda registrado en la bitácora de la membresía. (No cobra plata acá;
                solo activa y anota cómo se hizo.)
              </p>
            </div>
          )}

          <div className="ek-form-field">
            <label className="ek-label" htmlFor="np-nombre">Nombre completo</label>
            <input
              id="np-nombre"
              type="text"
              required
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              className="ek-input"
              placeholder="María González"
            />
          </div>

          <div className="ek-form-field">
            <label className="ek-label" htmlFor="np-email">Email</label>
            <input
              id="np-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="ek-input"
              placeholder="maria@ejemplo.com"
            />
          </div>

          <div className="ek-form-field">
            <label className="ek-label" htmlFor="np-telefono">
              Teléfono <span style={{ color: 'var(--ek-ink-muted)', fontWeight: 400 }}>(opcional)</span>
            </label>
            <input
              id="np-telefono"
              type="tel"
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              className="ek-input"
              placeholder="+52 667 123 4567"
            />
          </div>

          <div className="ek-form-field">
            <label className="ek-label" htmlFor="np-password">Password inicial</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                id="np-password"
                type="text"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="ek-input"
                placeholder="Mínimo 8 caracteres"
                style={{ fontFamily: 'var(--ek-font-mono)' }}
              />
              <button
                type="button"
                onClick={generarPassword}
                className="ek-cta ek-cta--secondary"
                style={{ minHeight: '48px', padding: '0 1rem', flexShrink: 0 }}
              >
                Generar
              </button>
            </div>
            <p className="ek-helper-text">Compártela con la persona por WhatsApp o en persona.</p>
          </div>

          {error && <p className="ek-error-text">{error}</p>}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button type="button" onClick={onClose} disabled={submitting} className="ek-cta ek-cta--secondary" style={{ flex: 1 }}>
              Cancelar
            </button>
            <button type="submit" disabled={submitting || !email || !password || !nombre} className="ek-cta" style={{ flex: 1 }}>
              {submitting ? 'Creando…' : 'Crear cuenta'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
