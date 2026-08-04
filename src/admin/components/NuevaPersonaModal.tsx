import { useEffect, useState } from 'react';
import {
  gestionarMembresiaSocio,
  useTiersAdmin
} from '../hooks/useAdminData';
import { useSucursal } from '../providers/SucursalProvider';
import { useTenant } from '@shared/hooks/useTenant';
import { guardarDatosPrivados, subirAvatarSocio } from '@shared/lib/datosSocio';
import { backendPost } from '@shared/lib/backend';
import { supabase } from '@shared/lib/supabase';
import { QrChico } from '@shared/components/QrChico';

/**
 * Alta de MIEMBRO (cliente que paga). Este modal vive en la página Miembros y
 * crea SOLO miembros: el equipo (admin/recepción) se crea desde Equipo, que es
 * la pantalla pensada para eso (con sus guardas: no degradar al último admin, no
 * cambiarte el rol a vos mismo). Antes acá había un selector con los tres roles,
 * así que se podía fabricar un admin desde la lista de clientes.
 */
const ROL_FIJO = 'miembro' as const;
type FormaActivacion = 'efectivo' | 'tarjeta' | 'transferencia' | 'cortesia';

// Asignar un plan activa al miembro (gestionar_membresia_socio pasa el status a
// 'activo'). Si se cobró (efectivo/transferencia) también SE REGISTRA EL PAGO en
// la Caja, con el precio del plan — igual que en recepción. Cortesía no cobra.
const MOTIVO_ALTA: Record<FormaActivacion, string> = {
  efectivo: 'Alta con pago en efectivo',
  tarjeta: 'Alta con pago por terminal',
  transferencia: 'Alta con pago por transferencia',
  cortesia: 'Alta de cortesía (sin cargo)',
};

// El método que va al RPC: efectivo/tarjeta/transferencia registran pago;
// cortesía → null (no cobra). Es lo que decide si el dinero entra o no a la Caja.
const METODO_PAGO: Record<FormaActivacion, string | null> = {
  efectivo: 'efectivo',
  tarjeta: 'tarjeta',
  transferencia: 'transferencia',
  cortesia: null,
};

interface Props {
  onClose: () => void;
  onCreated: () => Promise<void>;
}

export function NuevaPersonaModal({ onClose, onCreated }: Props) {
  const { tiers, isLoading: loadingTiers } = useTiersAdmin();
  const { sucursales, sucursalId: adminSucursalId, multisede } = useSucursal();
  const tenant = useTenant();
  const [email, setEmail] = useState('');
  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  // Ficha del socio (opcional): sexo/nacimiento/domicilio + foto, capturados AL
  // ALTA en vez de escondidos en una pantalla que nadie abre.
  const [fechaNac, setFechaNac] = useState('');
  const [sexo, setSexo] = useState('');
  const [domicilio, setDomicilio] = useState('');
  const [fotoFile, setFotoFile] = useState<File | null>(null);
  const rol = ROL_FIJO;
  // Sede de la persona (miembro/recepción en multisede). Default = la sede
  // activa del admin; el trigger de BD igual la rellena si quedara vacía.
  const [sucursalId, setSucursalId] = useState('');
  useEffect(() => {
    if (!sucursalId && adminSucursalId) setSucursalId(adminSucursalId);
  }, [adminSucursalId, sucursalId]);
  const pideSucursal = multisede;
  // tier_id (uuid) o '' para "sin plan". Antes era slug hardcoded — ahora se
  // resuelve desde useTiersAdmin, así soporta tiers custom del tenant.
  const [tierId, setTierId] = useState<string>('');
  const [formaActivacion, setFormaActivacion] = useState<FormaActivacion>('efectivo');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ email: string; warning?: string } | null>(null);


  const tiersActivos = tiers.filter((t) => t.activo);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      // Crea SOLO la ficha (sin login). El socio activa su cuenta solo en /activar
      // (ahí le sale su contraseña). El gym no dicta contraseñas.
      const res = await backendPost<{ usuario_id: string; email: string }>('crear-socio-ficha', {
        nombre: nombre.trim(),
        email: email.trim(),
        telefono: telefono.trim() || undefined,
        sucursal_id: pideSucursal ? sucursalId || null : null
      });

      // Ficha del socio (opcional). Best-effort: la ficha YA existe, así que un
      // fallo acá no debe tumbar el alta — se puede recargar desde la ficha.
      await guardarDatosPrivados(res.usuario_id, tenant.id, { fecha_nacimiento: fechaNac, sexo, domicilio });
      if (fotoFile) await subirAvatarSocio(res.usuario_id, fotoFile);

      // Si es miembro Y se eligió un tier, alta de membresía vía RPC. Eso
      // crea la fila en `membresias`, sincroniza `usuarios.membresia_tier`,
      // y pasa el status de pendiente_pago a activo.
      if (rol === 'miembro' && tierId) {
        const { error: memErr } = await gestionarMembresiaSocio({
          usuario_id: res.usuario_id,
          tier_id: tierId,
          motivo: MOTIVO_ALTA[formaActivacion],
          // Registra el pago en la Caja si se cobró; cortesía → null (no cobra).
          // El monto lo pone el RPC con el precio de lista del plan.
          metodo_pago: METODO_PAGO[formaActivacion]
        });
        if (memErr) {
          // El usuario YA está creado (auth + fila). Solo falló la membresía.
          // Lo tratamos como ÉXITO PARCIAL: mostramos las credenciales (así el
          // admin sabe que existe y no reintenta con el mismo email → "ya existe")
          // + un aviso para cargar el plan desde el perfil. NO es un error total.
          setSuccess({
            email: res.email,
            warning:
              `La ficha se creó, pero no se pudo asignar el plan: ${memErr}. ` +
              `Asígnalo desde el perfil de la persona (Miembros → su ficha).`
          });
          setSubmitting(false);
          return;
        }
        // Guardar el método de pago elegido en la membresía (informativo,
        // editable luego en la ficha). Best-effort: no tumba el alta.
        const metodo = METODO_PAGO[formaActivacion];
        if (metodo) {
          const rpc = supabase.rpc.bind(supabase) as unknown as (
            name: string, args: unknown
          ) => Promise<{ error: unknown }>;
          await rpc('establecer_metodo_pago', { p_usuario_id: res.usuario_id, p_metodo: metodo });
        }
      }

      setSuccess({ email: res.email });
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos crear el usuario. Prueba de nuevo.');
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="adm-modal-backdrop" onClick={async () => { await onCreated(); }}>
        <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
          <p className="ek-eyebrow" style={{ color: 'var(--ek-success)' }}>SOCIO CREADO</p>
          <h3 className="ek-h3">Dile que active su cuenta</h3>

          <p style={{ color: 'var(--ek-ink-muted)', fontSize: '0.9375rem', lineHeight: 1.5 }}>
            El socio activa su cuenta él mismo (ahí le sale su contraseña). Solo dile que
            entre con <strong>su email</strong> a esta dirección:
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

          <div className="ek-card" style={{ background: 'var(--ek-cream-warm)', display: 'flex', gap: '14px', alignItems: 'center' }}>
            <QrChico data={`${window.location.origin}/activar`} />
            <div style={{ minWidth: 0 }}>
              <div className="adm-info-label">Activar cuenta</div>
              <code style={{ fontFamily: 'var(--ek-font-mono)', userSelect: 'all', wordBreak: 'break-all', fontSize: '13px' }}>
                {`${window.location.origin}/activar`}
              </code>
              <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '6px 0 0' }}>
                Con su email: <strong>{success.email}</strong>
              </p>
            </div>
          </div>

          <button onClick={async () => { await onCreated(); }} className="ek-cta ek-cta--full">
            Listo
          </button>
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
                Sede donde se inscribe. Su plan define si entrena solo aquí o en todas.
              </p>
            </div>
          )}

          {(
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

          {tierId && (
            <div className="ek-form-field">
              <label className="ek-label" htmlFor="np-activacion">Activación</label>
              <select
                id="np-activacion"
                value={formaActivacion}
                onChange={(e) => setFormaActivacion(e.target.value as FormaActivacion)}
                className="ek-input"
              >
                <option value="efectivo">Activar — pagó en efectivo</option>
                <option value="tarjeta">Activar — pagó con terminal</option>
                <option value="transferencia">Activar — pagó por transferencia</option>
                <option value="cortesia">Cortesía / gratis (sin cargo)</option>
              </select>
              <p className="ek-helper-text">
                Con <strong>efectivo</strong> o <strong>transferencia</strong> se registra el
                pago en la Caja por el precio del plan. <strong>Cortesía</strong> activa sin cobrar.
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

          {/* Ficha del socio (opcional): se captura al alta, ya no escondida. */}
          <div className="ek-form-field">
            <label className="ek-label" htmlFor="np-nac">
              Fecha de nacimiento <span style={{ color: 'var(--ek-ink-muted)', fontWeight: 400 }}>(opcional)</span>
            </label>
            <input id="np-nac" type="date" value={fechaNac} onChange={(e) => setFechaNac(e.target.value)} className="ek-input" />
          </div>

          <div className="ek-form-field">
            <label className="ek-label" htmlFor="np-sexo">
              Sexo <span style={{ color: 'var(--ek-ink-muted)', fontWeight: 400 }}>(opcional)</span>
            </label>
            <select id="np-sexo" value={sexo} onChange={(e) => setSexo(e.target.value)} className="ek-input">
              <option value="">Sin especificar</option>
              <option value="femenino">Femenino</option>
              <option value="masculino">Masculino</option>
              <option value="otro">Otro</option>
            </select>
          </div>

          <div className="ek-form-field">
            <label className="ek-label" htmlFor="np-domicilio">
              Domicilio <span style={{ color: 'var(--ek-ink-muted)', fontWeight: 400 }}>(opcional)</span>
            </label>
            <input id="np-domicilio" type="text" value={domicilio} onChange={(e) => setDomicilio(e.target.value)} className="ek-input" placeholder="Calle, número, colonia, ciudad" />
          </div>

          <div className="ek-form-field">
            <label className="ek-label">
              Foto <span style={{ color: 'var(--ek-ink-muted)', fontWeight: 400 }}>(opcional)</span>
            </label>
            <label className="ek-cta ek-cta--secondary" style={{ cursor: 'pointer', display: 'inline-block', width: 'fit-content' }}>
              {fotoFile ? 'Cambiar foto' : 'Subir foto'}
              <input type="file" accept="image/*" onChange={(e) => setFotoFile(e.target.files?.[0] ?? null)} style={{ display: 'none' }} />
            </label>
            {fotoFile && <p className="ek-helper-text">{fotoFile.name}</p>}
          </div>

          <p className="ek-helper-text" style={{ margin: '4px 0 0' }}>
            No lleva contraseña: el socio activa su cuenta solo (en “Activar mi cuenta”) y ahí
            le sale su contraseña temporal.
          </p>

          {error && <p className="ek-error-text">{error}</p>}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button type="button" onClick={onClose} disabled={submitting} className="ek-cta ek-cta--secondary" style={{ flex: 1 }}>
              Cancelar
            </button>
            <button type="submit" disabled={submitting || !email || !nombre} className="ek-cta" style={{ flex: 1 }}>
              {submitting ? 'Creando…' : 'Crear cuenta'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
