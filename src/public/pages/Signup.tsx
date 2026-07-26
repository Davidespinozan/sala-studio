import { useEffect, useState, FormEvent } from 'react';
import { ArrowLeft, Check, Star } from 'lucide-react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { PasswordInput } from '@shared/components/PasswordInput';
import { validarPassword } from '../lib/onboardingLogic';
import { formatearPrecioTier, sufijoPeriodoTier } from '@shared/lib/precioTier';
import { socioPuedePagarEnApp } from '@shared/lib/cobrosDelGym';

interface TierRow {
  id: string;
  slug: string;
  nombre: string;
  precio_centavos: number;
  moneda: string;
  periodo: string;
  tipo: string;
  clases_incluidas: number | null;
  beneficios: unknown;
  reglas: unknown;
  orden: number | null;
}

function parseBeneficios(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((b): b is string => typeof b === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((b): b is string => typeof b === 'string')
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** ¿El gym marcó este plan como el recomendado? */
function esRecomendado(tier: TierRow): boolean {
  const reglas = tier.reglas as Record<string, unknown> | null;
  return reglas?.recomendado === true;
}

/**
 * El plan que se le va a mostrar al socio.
 *
 * Antes esto buscaba UN slug (`?tier=` o, si no venía, 'basica' clavado) y si no
 * lo encontraba hacía `<Navigate to="/" />`: en un gym cuyos planes no se llaman
 * 'basica'/'pro', entrar a /signup sin parámetro EXPULSABA al socio al inicio, en
 * silencio, sin poder registrarse nunca. Ahora se traen los planes del gym y se
 * elige: el del link, si existe; si no, el que el dueño marcó como recomendado; y
 * si no marcó ninguno, el más barato. Solo devuelve null si el gym no tiene ni un
 * plan activo, que es el único caso en el que de verdad no hay nada que mostrar.
 */
function useTierParaSignup(slugPedido: string | null) {
  const tenant = useTenant();
  const [tier, setTier] = useState<TierRow | null>(null);
  const [sinPlanes, setSinPlanes] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      // El filtro tenant_id es la PRIMERA línea de defensa para lecturas
      // anónimas: la RLS read_public no puede scopear por tenant (anon no tiene
      // JWT, get_my_tenant_id() es NULL).
      const { data, error } = await supabase
        .from('tiers')
        .select('id, slug, nombre, precio_centavos, moneda, periodo, tipo, clases_incluidas, beneficios, reglas, orden')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('precio_centavos', { ascending: true });

      if (!mounted) return;

      if (error) {
        console.error('[useTierParaSignup]', error);
        setIsLoading(false);
        return;
      }

      const planes = (data ?? []) as TierRow[];
      setSinPlanes(planes.length === 0);
      setTier(
        planes.find((t) => t.slug === slugPedido) ??
          planes.find(esRecomendado) ??
          planes[0] ??
          null
      );
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [slugPedido, tenant.id]);

  return { tier, sinPlanes, isLoading };
}

function useSucursalesSignup() {
  const tenant = useTenant();
  const [sucursales, setSucursales] = useState<{ id: string; nombre: string }[]>([]);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from('sucursales')
        .select('id, nombre')
        .eq('tenant_id', tenant.id)
        .eq('activa', true)
        .order('orden', { ascending: true })
        .order('created_at', { ascending: true });
      if (!mounted) return;
      if (error) console.error('[useSucursalesSignup]', error);
      else setSucursales((data ?? []) as { id: string; nombre: string }[]);
    }
    load();
    return () => { mounted = false; };
  }, [tenant.id]);

  return sucursales;
}

export default function Signup() {
  const navigate = useNavigate();
  const tenant = useTenant();
  const [searchParams] = useSearchParams();
  const tierParam = searchParams.get('tier');
  const { tier: plan, sinPlanes, isLoading: tierLoading } = useTierParaSignup(tierParam);
  const sucursales = useSucursalesSignup();
  const multisede = sucursales.length > 1;

  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [sucursalId, setSucursalId] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acepta, setAcepta] = useState(false);


  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!plan) {
      setError('No pudimos cargar el plan. Recargá la página.');
      return;
    }
    if (!acepta) {
      setError('Debes aceptar los términos y el aviso de privacidad para continuar.');
      return;
    }
    if (password !== passwordConfirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    // Misma regla que onboarding/recuperación (8 + letra + número): antes signup
    // aceptaba 6 y después el form de login (minLength 8) la rechazaba.
    const passCheck = validarPassword(password);
    if (!passCheck.ok) {
      setError(passCheck.error ?? 'La contraseña no es válida.');
      return;
    }
    if (multisede && !sucursalId) {
      setError('Elige la sede a la que te quieres inscribir.');
      return;
    }
    setIsProcessing(true);

    try {
      const response = await fetch('/.netlify/functions/fake-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre,
          email,
          password,
          tier: plan.slug,
          slug: tenant.slug, // el socio se da de alta en ESTE gimnasio (subdominio)
          sucursal_id: multisede ? sucursalId : null
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'No pudimos crear tu cuenta.');
      }

      // Auto-login
      const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
      if (loginError) {
        throw new Error('Cuenta creada pero error al iniciar sesión. Inicia sesión manualmente.');
      }

      // Demo / plan gratis → membresía ya activa. Gym real con plan pago → cae en
      // /app 'pendiente_pago' y ahí se abre directo el modal de pago de SALA.
      navigate('/app');
    } catch (err) {
      console.error('[Signup]', err);
      setError(err instanceof Error ? err.message : 'Error inesperado. Intenta de nuevo.');
      setIsProcessing(false);
    }
  }

  if (tierLoading) {
    return (
      <div style={{ maxWidth: '480px', margin: '40px auto', padding: '0 24px' }}>
        <div className="ek-skeleton" style={{ height: '600px', borderRadius: 'var(--ek-r-card)' }} />
      </div>
    );
  }

  if (!plan) {
    // El gym todavía no publicó ningún plan. Antes acá se caía un <Navigate to="/">
    // también cuando el plan existía pero tenía otro slug: el socio rebotaba al
    // inicio sin explicación y no se podía registrar nunca.
    return (
      <div style={{ maxWidth: '480px', margin: '80px auto', padding: '0 24px', textAlign: 'center' }}>
        <h1 className="ek-h3" style={{ marginBottom: '8px' }}>Todavía no hay planes disponibles</h1>
        <p style={{ color: 'var(--ek-ink-muted)', fontSize: '14px', marginBottom: '24px' }}>
          {sinPlanes
            ? `${tenant.nombre} todavía no publicó sus planes. Escribinos y te avisamos apenas estén.`
            : 'No pudimos cargar los planes. Recargá la página.'}
        </p>
        <Link to="/" className="ek-btn ek-btn--ghost">Volver al inicio</Link>
      </div>
    );
  }

  const destacado = esRecomendado(plan);
  const precio = formatearPrecioTier(plan.precio_centavos, plan.moneda);
  const sufijo = sufijoPeriodoTier(plan);
  const beneficios = parseBeneficios(plan.beneficios).slice(0, 4);
  // ¿Al socio le vamos a pedir la tarjeta, o el gym le cobra por fuera? Connect
  // listo Y autoservicio prendido. numa: autoservicio off → siempre "sin cargo,
  // coordina el pago con el gym".
  const cobraOnline = socioPuedePagarEnApp(tenant);

  return (
    <div style={{
      maxWidth: '480px',
      margin: '0 auto',
      padding: '40px 24px',
      minHeight: '100vh'
    }}>
      <Link to="/" style={{
        fontSize: '13px',
        color: 'var(--ek-ink-muted)',
        textDecoration: 'none',
        marginBottom: '32px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px'
      }}>
        <ArrowLeft size={14} strokeWidth={2.25} />
        Volver a {tenant.nombre}
      </Link>

      {/* Plan resumen */}
      <div className="ek-card" style={{
        padding: '24px',
        marginBottom: '32px',
        borderColor: destacado ? 'var(--ek-mustard)' : 'var(--ek-line)'
      }}>
        {/* El nombre REAL del plan del gym. Antes decía "MEMBRESÍA BÁSICA" encima
            de cualquier plan que no tuviera el slug 'pro'. */}
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          {destacado && <Star size={12} strokeWidth={2.5} fill="currentColor" />}
          {plan.nombre.toUpperCase()}
        </p>
        <p style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '36px',
          fontWeight: 700,
          margin: 0,
          letterSpacing: '-0.03em',
          lineHeight: 1
        }}>
          {precio}
          <span style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>
            {sufijo}
          </span>
        </p>
        <ul style={{ listStyle: 'none', padding: 0, margin: '16px 0 0 0', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {beneficios.map((b) => (
            <li key={b} style={{ display: 'flex', gap: '8px', fontSize: '13px', alignItems: 'flex-start' }}>
              <Check size={15} strokeWidth={2.5} style={{ color: 'var(--ek-mustard)', flexShrink: 0, marginTop: '1px' }} />{b}
            </li>
          ))}
        </ul>
      </div>

      <form onSubmit={handleSubmit} className="ek-stack-md">
        <p className="ek-eyebrow" style={{ marginBottom: '4px' }}>TUS DATOS</p>

        <div className="ek-form-field">
          <label className="ek-label" htmlFor="signup-nombre">Nombre completo</label>
          <input
            id="signup-nombre"
            type="text"
            className="ek-input"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            required
            disabled={isProcessing}
            autoComplete="name"
          />
        </div>

        <div className="ek-form-field">
          <label className="ek-label" htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            type="email"
            className="ek-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={isProcessing}
            autoComplete="email"
          />
        </div>

        <div className="ek-form-field">
          <label className="ek-label" htmlFor="signup-password">Contraseña</label>
          <PasswordInput
            id="signup-password"
            value={password}
            onChange={setPassword}
            required
            minLength={8}
            disabled={isProcessing}
            autoComplete="new-password"
          />
        </div>

        <div className="ek-form-field">
          <label className="ek-label" htmlFor="signup-password-confirm">Confirmar contraseña</label>
          <PasswordInput
            id="signup-password-confirm"
            value={passwordConfirm}
            onChange={setPasswordConfirm}
            required
            disabled={isProcessing}
            autoComplete="new-password"
          />
        </div>

        {multisede && (
          <div className="ek-form-field">
            <label className="ek-label" htmlFor="signup-sucursal">Sede</label>
            <select
              id="signup-sucursal"
              className="ek-input"
              value={sucursalId}
              onChange={(e) => setSucursalId(e.target.value)}
              required
              disabled={isProcessing}
            >
              <option value="">Elige tu sede…</option>
              {sucursales.map((s) => (
                <option key={s.id} value={s.id}>{s.nombre}</option>
              ))}
            </select>
            <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
              Es la sede donde entrenarás. Tu plan define si te da acceso solo a ella o a todas.
            </p>
          </div>
        )}

        {/* Qué pasa después de registrarse. Este cartel decía SIEMPRE "no te
            pedimos tarjeta" —resto de cuando no había cobro online—, así que en
            un gym con cobros activos le mentía al socio: leía "sin cargo" y
            enseguida le aparecía el checkout pidiéndole la tarjeta. Ahora
            depende de si ESTE gym cobra online y de si el plan tiene precio. */}
        <div
          style={{
            marginTop: '20px',
            background: 'var(--sala-primary-light, var(--ek-bg-soft))',
            border: '0.5px solid var(--sala-border, var(--ek-line))',
            borderRadius: 'var(--ek-r-md)',
            padding: '14px 16px'
          }}
        >
          <p style={{ fontSize: '13px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.5 }}>
            {cobraOnline && plan.precio_centavos > 0 ? (
              <>
                <strong>Pagás al terminar.</strong> Creás tu cuenta y enseguida te pedimos la
                tarjeta para activar tu plan de {precio}. El cobro lo procesa {tenant.nombre} de
                forma segura.
              </>
            ) : plan.precio_centavos > 0 ? (
              <>
                <strong>Sin cargo por ahora.</strong> Activás tu cuenta al instante y{' '}
                {tenant.nombre} coordina el pago con vos. No te pedimos tarjeta acá.
              </>
            ) : (
              <>
                <strong>Este plan es gratis.</strong> Activás tu cuenta al instante y no te pedimos
                tarjeta.
              </>
            )}
          </p>
        </div>

        {error && (
          <div style={{
            background: 'var(--sala-error-bg)',
            border: '0.5px solid var(--ek-danger)',
            borderRadius: 'var(--ek-r-sm)',
            padding: '12px 16px',
            color: 'var(--ek-danger)',
            fontSize: '13px'
          }}>
            {error}
          </div>
        )}

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginTop: '12px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={acepta}
            onChange={(e) => setAcepta(e.target.checked)}
            disabled={isProcessing}
            style={{ marginTop: '3px', width: '16px', height: '16px', flexShrink: 0, cursor: 'pointer' }}
          />
          <span style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', lineHeight: 1.5 }}>
            Acepto los{' '}
            <Link to="/terminos" style={{ color: 'var(--ek-mustard)' }}>Términos y condiciones</Link>
            {' '}y el{' '}
            <Link to="/privacidad" style={{ color: 'var(--ek-mustard)' }}>Aviso de privacidad</Link>.
          </span>
        </label>

        <button
          type="submit"
          className="ek-cta ek-cta--full ek-cta--solid"
          style={{ marginTop: '12px', padding: '16px', fontSize: '15px' }}
          disabled={isProcessing || !acepta}
        >
          {isProcessing
            ? 'Activando tu cuenta…'
            : `Activar mi plan — ${precio}${sufijo}`
          }
        </button>

        <p style={{
          fontSize: '11px',
          color: 'var(--ek-ink-faint)',
          textAlign: 'center',
          marginTop: '4px',
          lineHeight: 1.5
        }}>
          El gimnasio coordina el cobro de tu plan contigo.
        </p>

        <p style={{
          fontSize: '12px',
          color: 'var(--ek-ink-muted)',
          textAlign: 'center',
          marginTop: '12px'
        }}>
          ¿Ya tienes cuenta? <Link to="/login" style={{ color: 'var(--ek-mustard)' }}>Iniciar sesión</Link>
        </p>
      </form>
    </div>
  );
}
