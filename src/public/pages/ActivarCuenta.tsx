import { useState, FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { backendPost } from '@shared/lib/backend';
import { TenantLogo } from '@shared/components/TenantLogo';
import { PoweredBySala } from '@shared/components/PoweredBySala';
import { useTenant } from '@shared/hooks/useTenant';
import { PASSWORD_TEMPORAL_INICIAL } from '@shared/lib/acceso';

/**
 * ACTIVAR MI CUENTA — autoservicio por email, sin código, para socios YA dados
 * de alta en recepción. Si el email tiene ficha → se activa la cuenta; si no lo
 * reconoce → lo manda a recepción (NO crea ficha, para no duplicar). Entra con la
 * contraseña temporal fija y la app lo obliga a cambiarla. (La seguridad real es
 * huella + recepción; ver acceso.ts.)
 */
export default function ActivarCuenta() {
  const navigate = useNavigate();
  const tenant = useTenant();
  const tieneIsotipo = typeof (tenant.branding as Record<string, unknown> | null)?.isotipo_url === 'string';

  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState<{ nueva: boolean } | null>(null);
  const [entrando, setEntrando] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const res = await backendPost<{ success: boolean; nueva: boolean }>('activar-cuenta', {
        email: email.trim(),
        slug: tenant.slug
      });
      setListo({ nueva: !!res.nueva });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos activar tu cuenta. Intenta de nuevo.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function entrar() {
    setEntrando(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password: PASSWORD_TEMPORAL_INICIAL
    });
    if (signInError) {
      navigate('/login', { replace: true }); // que entre a mano con la clave temporal
      return;
    }
    navigate('/', { replace: true }); // la app le exige cambiar la contraseña
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 20px' }}>
      <div style={{ maxWidth: '400px', width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '40px' }}>
          {tieneIsotipo
            ? <TenantLogo variant="isotipo" height={112} />
            : <TenantLogo variant="completo" height={60} fallbackFontSize={42} showSuffix />}
        </div>

        <div
          className="ek-card"
          style={{
            background: 'linear-gradient(160deg, var(--sala-surface) 0%, var(--sala-primary-light) 100%)',
            border: '1px solid var(--sala-primary-soft)',
            boxShadow: '0 12px 32px var(--sala-primary-dim)'
          }}
        >
          {listo ? (
            <>
              <div style={{ marginBottom: 14 }}>
                <p className="ek-eyebrow" style={{ margin: 0, color: 'var(--sala-success)' }}>CUENTA LISTA</p>
                <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: 22, fontWeight: 700, margin: '4px 0 0' }}>Entra con esta contraseña</h1>
                <p style={{ fontSize: 13, color: 'var(--sala-text-secondary)', marginTop: 6, lineHeight: 1.5 }}>
                  {listo.nueva
                    ? <>Tu cuenta quedó creada. Para <strong>reservar</strong>, pasa a recepción a activar tu plan.</>
                    : 'Ya puedes entrar y reservar.'}
                </p>
              </div>

              <div style={{ background: 'var(--sala-surface)', border: '0.5px solid var(--sala-border)', borderRadius: 'var(--ek-r-md)', padding: '14px 16px', marginBottom: 16 }}>
                <p style={{ fontSize: 11, color: 'var(--sala-text-tertiary)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tu contraseña temporal</p>
                <p style={{ fontFamily: 'var(--ek-font-mono)', fontSize: 26, fontWeight: 800, letterSpacing: '0.08em', margin: '4px 0 0', color: 'var(--sala-text-primary)' }}>{PASSWORD_TEMPORAL_INICIAL}</p>
                <p style={{ fontSize: 12, color: 'var(--sala-text-tertiary)', margin: '6px 0 0', lineHeight: 1.45 }}>
                  Al entrar, la app te va a pedir que la cambies por una tuya.
                </p>
              </div>

              <button type="button" onClick={() => void entrar()} disabled={entrando} className="ek-cta ek-cta--full ek-cta--solid">
                {entrando ? 'Entrando…' : 'Entrar ahora'}
              </button>
            </>
          ) : (
            <>
              <div style={{ marginBottom: 16 }}>
                <p className="ek-eyebrow" style={{ margin: 0 }}>ACCESO</p>
                <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: 22, fontWeight: 700, margin: '4px 0 0' }}>Activa tu cuenta</h1>
                <p style={{ fontSize: 13, color: 'var(--sala-text-secondary)', marginTop: 6, lineHeight: 1.5 }}>
                  Pon el email con el que te registraron en {tenant.nombre || 'el gimnasio'} y activa tu cuenta. ¿Aún no eres socio? Pasa a recepción para darte de alta.
                </p>
              </div>

              <form onSubmit={handleSubmit} className="ek-stack-md">
                <div className="ek-form-field">
                  <label htmlFor="email" className="ek-label">Email</label>
                  <input id="email" type="email" autoComplete="email" required value={email}
                    onChange={(e) => setEmail(e.target.value)} className="ek-input" placeholder="tu@email.com" />
                </div>

                {error && <p className="ek-error-text">{error}</p>}

                <button type="submit" className="ek-cta ek-cta--full ek-cta--solid" disabled={isSubmitting || !email}>
                  {isSubmitting ? 'Activando…' : 'Activar mi cuenta'}
                </button>

                <div style={{ textAlign: 'center', marginTop: 6 }}>
                  <Link to="/login" style={{ fontSize: 13, color: 'var(--ek-mustard)', textDecoration: 'none' }}>
                    ¿Ya tienes acceso? Inicia sesión
                  </Link>
                </div>
              </form>
            </>
          )}
        </div>

        <PoweredBySala />
      </div>
    </div>
  );
}