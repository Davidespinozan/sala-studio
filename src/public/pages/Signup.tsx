import { useEffect, useState, FormEvent } from 'react';
import { useNavigate, useSearchParams, Link, Navigate } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';

type Tier = 'basica' | 'pro';

interface PlanInfo {
  nombre: string;
  precio: number;
  tier: Tier;
  beneficios: string[];
}

interface TierRow {
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
  const [tier, setTier] = useState<TierRow | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from('tiers')
        .select('slug, nombre, precio_centavos, beneficios')
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
  }, [slug]);

  return { tier, isLoading };
}

export default function Signup() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const tierParam = (searchParams.get('tier') as Tier) || 'basica';
  const { tier: tierRow, isLoading: tierLoading } = useTierPorSlug(tierParam);

  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [cardExp, setCardExp] = useState('');
  const [cardCvv, setCardCvv] = useState('');
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

  const handleCardNumber = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 16);
    const formatted = digits.replace(/(.{4})/g, '$1 ').trim();
    setCardNumber(formatted);
  };

  const handleCardExp = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 4);
    if (digits.length >= 3) {
      setCardExp(`${digits.slice(0, 2)}/${digits.slice(2)}`);
    } else {
      setCardExp(digits);
    }
  };

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== passwordConfirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    if (password.length < 6) {
      setError('La contraseña debe tener al menos 6 caracteres.');
      return;
    }
    if (cardNumber.replace(/\s/g, '').length !== 16) {
      setError('El número de tarjeta debe tener 16 dígitos.');
      return;
    }
    if (cardExp.length !== 5) {
      setError('Fecha de vencimiento inválida.');
      return;
    }
    if (cardCvv.length !== 3) {
      setError('CVV inválido.');
      return;
    }

    setIsProcessing(true);

    try {
      // Simular procesamiento de pago (2 segundos)
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const response = await fetch('/.netlify/functions/fake-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre,
          email,
          password,
          tier: plan!.tier
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Error al procesar pago');
      }

      // Auto-login
      const { error: loginError } = await supabase.auth.signInWithPassword({
        email,
        password
      });

      if (loginError) {
        throw new Error('Cuenta creada pero error al iniciar sesión. Inicia sesión manualmente.');
      }

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
        display: 'inline-block'
      }}>
        ← Volver a EKKO
      </Link>

      {/* Plan resumen */}
      <div className="ek-card" style={{
        padding: '24px',
        marginBottom: '32px',
        borderColor: plan.tier === 'pro' ? 'var(--ek-mustard)' : 'var(--ek-line)'
      }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>
          {plan.tier === 'pro' ? '★ PRO · MEMBRESÍA' : 'MEMBRESÍA BÁSICA'}
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
            <li key={b} style={{ display: 'flex', gap: '8px', fontSize: '13px' }}>
              <span style={{ color: 'var(--ek-mustard)' }}>✓</span>{b}
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
            minLength={6}
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

        <p className="ek-eyebrow" style={{ marginTop: '20px', marginBottom: '4px' }}>
          PAGO
        </p>

        <div className="ek-form-field">
          <label className="ek-label" htmlFor="signup-card">Número de tarjeta</label>
          <input
            id="signup-card"
            type="text"
            className="ek-input"
            placeholder="0000 0000 0000 0000"
            value={cardNumber}
            onChange={(e) => handleCardNumber(e.target.value)}
            required
            disabled={isProcessing}
            inputMode="numeric"
            autoComplete="cc-number"
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div className="ek-form-field">
            <label className="ek-label" htmlFor="signup-exp">Vencimiento</label>
            <input
              id="signup-exp"
              type="text"
              className="ek-input"
              placeholder="MM/AA"
              value={cardExp}
              onChange={(e) => handleCardExp(e.target.value)}
              required
              disabled={isProcessing}
              inputMode="numeric"
              autoComplete="cc-exp"
            />
          </div>
          <div className="ek-form-field">
            <label className="ek-label" htmlFor="signup-cvv">CVV</label>
            <input
              id="signup-cvv"
              type="text"
              className="ek-input"
              placeholder="000"
              value={cardCvv}
              onChange={(e) => setCardCvv(e.target.value.replace(/\D/g, '').slice(0, 3))}
              required
              disabled={isProcessing}
              inputMode="numeric"
              autoComplete="cc-csc"
            />
          </div>
        </div>

        {error && (
          <div style={{
            background: 'rgba(226, 85, 85, 0.1)',
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
            ? 'Procesando pago…'
            : `Pagar y empezar — $${plan.precio.toLocaleString('es-MX')}/mes`
          }
        </button>

        <p style={{
          fontSize: '11px',
          color: 'var(--ek-ink-faint)',
          textAlign: 'center',
          marginTop: '4px',
          lineHeight: 1.5
        }}>
          Al continuar aceptas los términos. Compromiso mínimo de 6 meses.<br />
          Pago mensual recurrente, cancelas en cualquier momento.
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
