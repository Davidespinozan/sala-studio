import { useEffect, useState } from 'react';
import { adminCreateUser } from '@admin/hooks/useAdminData';
import { useReceptionSucursal } from '../providers/ReceptionSucursalProvider';
import { useTenant } from '@shared/hooks/useTenant';
import { guardarDatosPrivados } from '@shared/lib/datosSocio';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function generarPassword(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * Alta de un socio (walk-in) desde el mostrador. Recepción crea la cuenta
 * (rol='miembro', status pendiente_pago) en su sede actual; el PLAN se asigna
 * después desde la ficha del socio ("Asignar plan"). Dos fases: datos →
 * credenciales para entregar. Modal autónomo (no AccionModal, que cierra tras
 * confirmar) para poder mostrar las credenciales sin cerrar.
 */
export function RegistrarSocioModal({ isOpen, onClose, onDone }: Props) {
  const { sucursalId, multisede } = useReceptionSucursal();
  const tenant = useTenant();
  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [telefono, setTelefono] = useState('');
  // Ficha del socio (opcional): sexo/nacimiento/domicilio, pedidos AL ALTA.
  const [fechaNac, setFechaNac] = useState('');
  const [sexo, setSexo] = useState('');
  const [domicilio, setDomicilio] = useState('');
  const [password, setPassword] = useState(generarPassword);
  const [creado, setCreado] = useState<{ email: string; password: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset al abrir + scroll-lock + Escape (no cierra mientras se envía).
  useEffect(() => {
    if (!isOpen) return;
    setNombre(''); setEmail(''); setTelefono(''); setPassword(generarPassword());
    setFechaNac(''); setSexo(''); setDomicilio('');
    setCreado(null); setError(null); setSubmitting(false);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const emailOk = EMAIL_RE.test(email.trim());
  const canConfirm = nombre.trim().length > 1 && emailOk && password.length >= 8 && !submitting;

  async function crear() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminCreateUser({
        email: email.trim().toLowerCase(),
        password,
        nombre: nombre.trim(),
        telefono: telefono.trim() || undefined,
        rol: 'miembro',
        membresia_tier: null,
        sucursal_id: multisede ? sucursalId : null
      });
      // Ficha del socio (opcional). Best-effort: el socio YA existe, un fallo acá
      // no debe tumbar el alta (se puede completar luego desde su ficha).
      await guardarDatosPrivados(res.user.id, tenant.id, { fecha_nacimiento: fechaNac, sexo, domicilio });
      setCreado({ email: res.user.email, password: res.user.password });
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear el socio.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={() => !submitting && onClose()}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(26, 31, 28, 0.55)',
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', zIndex: 110,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        animation: 'ek-fade-in 0.18s ease'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)', border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-card)', maxWidth: '480px', width: '100%', padding: '28px',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p className="ek-eyebrow" style={{ color: 'var(--ek-ink-muted)', marginBottom: '8px' }}>
          {creado ? 'SOCIO CREADO' : 'NUEVO SOCIO'}
        </p>
        <h3 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '20px', fontWeight: 700, letterSpacing: '-0.02em', margin: '0 0 12px', color: 'var(--ek-ink)' }}>
          {creado ? 'Listo, pasale los datos' : 'Alta en el mostrador'}
        </h3>

        {creado ? (
          <>
            <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', lineHeight: 1.55, margin: '0 0 16px' }}>
              Estos son los datos de acceso del socio. Para activarle un plan, abrí su ficha y usá “Asignar plan”.
            </p>
            <div style={{ background: 'var(--sala-surface)', border: '0.5px solid var(--ek-line)', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '18px' }}>
              <Dato label="Email de acceso" valor={creado.email} />
              <Dato label="Contraseña temporal" valor={creado.password} />
            </div>
            <button type="button" onClick={onClose} className="ek-cta" style={{ width: '100%' }}>
              Listo
            </button>
          </>
        ) : (
          <>
            <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', lineHeight: 1.55, margin: '0 0 16px' }}>
              Alta rápida de un socio. El plan se asigna después desde su ficha.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
              <Campo label="Nombre">
                <input className="ek-input" value={nombre} onChange={(e) => setNombre(e.target.value)} autoComplete="off" autoFocus />
              </Campo>
              <Campo label="Email de acceso">
                <input className="ek-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" placeholder="socio@email.com" />
              </Campo>
              <Campo label="Teléfono (opcional)">
                <input className="ek-input" value={telefono} onChange={(e) => setTelefono(e.target.value)} autoComplete="off" />
              </Campo>
              <Campo label="Fecha de nacimiento (opcional)">
                <input className="ek-input" type="date" value={fechaNac} onChange={(e) => setFechaNac(e.target.value)} />
              </Campo>
              <Campo label="Sexo (opcional)">
                <select className="ek-input" value={sexo} onChange={(e) => setSexo(e.target.value)}>
                  <option value="">Sin especificar</option>
                  <option value="femenino">Femenino</option>
                  <option value="masculino">Masculino</option>
                  <option value="otro">Otro</option>
                </select>
              </Campo>
              <Campo label="Domicilio (opcional)">
                <input className="ek-input" value={domicilio} onChange={(e) => setDomicilio(e.target.value)} placeholder="Calle, número, colonia, ciudad" autoComplete="off" />
              </Campo>
              <Campo label="Contraseña temporal">
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input className="ek-input" value={password} onChange={(e) => setPassword(e.target.value)} style={{ flex: 1 }} />
                  <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: '0 0 auto', padding: '0 14px' }} onClick={() => setPassword(generarPassword())}>
                    Generar
                  </button>
                </div>
              </Campo>
            </div>

            {error && (
              <p style={{ color: 'var(--ek-danger)', background: 'var(--ek-danger-soft)', border: '0.5px solid var(--sala-error-glow)', borderRadius: 'var(--ek-r-md)', padding: '10px 12px', fontSize: '0.875rem', margin: '0 0 16px' }}>
                {error}
              </p>
            )}

            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" onClick={() => !submitting && onClose()} disabled={submitting} className="ek-cta ek-cta--secondary" style={{ flex: 1 }}>
                Cancelar
              </button>
              <button type="button" onClick={crear} disabled={!canConfirm} className="ek-cta" style={{ flex: 1, opacity: !canConfirm && !submitting ? 0.4 : 1 }}>
                {submitting ? 'Creando…' : 'Crear socio'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span className="ek-label" style={{ display: 'block', marginBottom: '5px' }}>{label}</span>
      {children}
    </label>
  );
}

function Dato({ label, valor }: { label: string; valor: string }) {
  return (
    <div>
      <p style={{ fontSize: '11px', color: 'var(--ek-ink-muted)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</p>
      <p style={{ fontSize: '15px', fontWeight: 600, color: 'var(--sala-text-primary)', margin: '2px 0 0', fontFamily: 'var(--ek-font-mono)' }}>{valor}</p>
    </div>
  );
}
