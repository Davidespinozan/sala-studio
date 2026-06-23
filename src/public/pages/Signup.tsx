import { useEffect, useState, FormEvent } from 'react';
import { ArrowLeft, Check, Star } from 'lucide-react';
import { useNavigate, useSearchParams, Link, Navigate } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { validarPassword } from '../lib/onboardingLogic';

type Tier = 'basica' | 'pro';

interface PlanInfo {
  nombre: string;
  precio: number;
  tier: Tier;
  beneficios: string[];
}

interface TierRow {
  id: string;
  slug: string;
  nombre: string;
  precio_centavos: number;
  beneficios: unknown;
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

function useTierPorSlug(slug: string) {
  const tenant = useTenant();
  const [tier, setTier] = useState<TierRow | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      // El filtro tenant_id es la PRIMERA línea de defensa para lecturas
      // anónimas: la RLS read_public no puede scopear por tenant (anon no
      // tiene JWT, get_my_tenant_id() es NULL). Además es lo que hace que
      // maybeSingle() sea seguro: sin él, dos tenants con el mismo slug de
      // tier (basica/pro) devolverían múltiples filas y romperían la query.
      const { data, error } = await supabase
        .from('tiers')
        .select('id, slug, nombre, precio_centavos, beneficios')
        .eq('tenant_id', tenant.id)
        .eq('slug', slug)
        .eq('activo', true)
        .maybeSingle();

      if (!mounted) return;
      if (error) console.error('[useTierPorSlug]', error);
      else setTier(data as TierRow | null);
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [slug, tenant.id]);

  return { tier, isLoading };
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
  const tierParam = (searchParams.get('tier') as Tier) || 'basica';
  const { tier: tierRow, isLoading: tierLoading } = useTierPorSlug(tierParam);
  const sucursales = useSucursalesSignup();
  const multisede = sucursales.length > 1;

  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [sucursalId, setSucursalId] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plan: PlanInfo | null = tierRow
    ? {
        nombre: tierRow.nombre,
        precio: Math.round(tierRow.precio_centavos / 100),
        tier: tierRow.slug as Tier,
        beneficios: parseBeneficios(tierRow.beneficios).slice(0, 4)
      }
    : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

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
          tier: plan!.tier,
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
    return <Navigate to="/" replace />;
  }

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
        Volver a SALA
      </Link>

      {/* Plan resumen */}
      <div className="ek-card" style={{
        padding: '24px',
        marginBottom: '32px',
        borderColor: plan.tier === 'pro' ? 'var(--ek-mustard)' : 'var(--ek-line)'
      }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          {plan.tier === 'pro'
            ? <><Star size={12} strokeWidth={2.5} fill="currentColor" /> PRO · MEMBRESÍA</>
            : 'MEMBRESÍA BÁSICA'}
        </p>
        <p style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '36px',
          fontWeight: 700,
          margin: 0,
          letterSpacing: '-0.03em',
          lineHeight: 1
        }}>
          ${plan.precio.toLocaleString('es-MX')}
          <span style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>/mes</span>
        </p>
        <ul style={{ listStyle: 'none', padding: 0, margin: '16px 0 0 0', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {plan.beneficios.map((b) => (
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
          <input
            id="signup-password"
            type="password"
            className="ek-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            disabled={isProcessing}
            autoComplete="new-password"
          />
        </div>

        <div className="ek-form-field">
          <label className="ek-label" htmlFor="signup-password-confirm">Confirmar contraseña</label>
          <input
            id="signup-password-confirm"
            type="password"
            className="ek-input"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
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
            <strong>Sin cargo por ahora.</strong> Activas tu plan al instante; el gimnasio
            coordina el pago contigo. No te pedimos tarjeta.
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

        <button
          type="submit"
          className="ek-cta ek-cta--full"
          style={{ marginTop: '12px', padding: '16px', fontSize: '15px' }}
          disabled={isProcessing}
        >
          {isProcessing
            ? 'Activando tu cuenta…'
            : `Activar mi plan — $${plan.precio.toLocaleString('es-MX')}/mes`
          }
        </button>

        <p style={{
          fontSize: '11px',
          color: 'var(--ek-ink-faint)',
          textAlign: 'center',
          marginTop: '4px',
          lineHeight: 1.5
        }}>
          Al continuar aceptas los términos.<br />
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
