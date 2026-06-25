import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { CheckoutSaasEmbedded } from '@public/components/CheckoutSaasEmbedded';
import { TIMEZONE_OPTIONS } from '@shared/lib/timezone';
import { MARKETING_DOMAIN } from '@shared/providers/TenantProvider';
import {
  PLANES_SAAS,
  TIERS_ORDEN,
  TRIAL_DIAS,
  formatPrecio,
  precioCentavos,
  monedaPorTimezone,
  type TierSaas,
  type MonedaSaas
} from '@shared/lib/planesSaas';
import {
  validarPasoCuenta,
  validarPasoGym,
  validarPasoPlan,
  validarPasoSetup,
  validarSubdominio,
  sugerirSubdominio,
  construirPayloadOnboarding,
  COLOR_PRIMARIO_DEFAULT,
  COLOR_ACENTO_DEFAULT,
  type OnboardingState
} from '../lib/onboardingLogic';

const PASOS = ['Cuenta', 'Tu gym', 'Plan', 'Pago', 'Setup'];

const ESTADO_INICIAL: OnboardingState = {
  cuenta: { nombre: '', email: '', emailConfirm: '', password: '', passwordConfirm: '' },
  gym: { gymNombre: '', slug: '', timezone: 'America/Mexico_City' },
  tier: null,
  setup: { colorPrimario: COLOR_PRIMARIO_DEFAULT, colorAcento: COLOR_ACENTO_DEFAULT, logoUrl: null, salaNombre: '', salaCupo: 15 }
};

/** URL del gym recién creado (subdominio). En dev/preview construye contra el
 *  host actual (*.localhost resuelve solo); en prod, contra el apex canónico de
 *  marketing — nunca contra window.location.host, que anidaría subdominios. */
function urlDelGym(slug: string): string {
  if (typeof window === 'undefined') return `https://${slug}.${MARKETING_DOMAIN}/admin`;
  const { protocol, host } = window.location;
  const esDevOPreview =
    host.includes('localhost') || host.startsWith('127.') || host.endsWith('.netlify.app');
  const base = esDevOPreview ? host.replace(/^www\./, '') : MARKETING_DOMAIN;
  return `${protocol}//${slug}.${base}/admin`;
}

export default function Onboarding() {
  const [searchParams] = useSearchParams();
  const [paso, setPaso] = useState(0);
  // Preseleccionar el plan elegido en la landing (?plan=), si es válido.
  const [state, setState] = useState<OnboardingState>(() => {
    const planParam = searchParams.get('plan');
    const tier = planParam && (TIERS_ORDEN as readonly string[]).includes(planParam)
      ? (planParam as TierSaas)
      : null;
    return { ...ESTADO_INICIAL, tier };
  });
  const [errorPaso, setErrorPaso] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resultado, setResultado] = useState<{ slug: string } | null>(null);
  const [pendienteCobro, setPendienteCobro] = useState<{ slug: string } | null>(null);

  function avanzar(validacion: { ok: boolean; error?: string }) {
    if (!validacion.ok) {
      setErrorPaso(validacion.error ?? 'Revisa los datos.');
      return;
    }
    setErrorPaso(null);
    setPaso((p) => p + 1);
  }

  function retroceder() {
    setErrorPaso(null);
    setPaso((p) => Math.max(0, p - 1));
  }

  async function crearGym() {
    const v = validarPasoSetup(state.setup);
    if (!v.ok) {
      setErrorPaso(v.error ?? 'Revisa los datos.');
      return;
    }
    setErrorPaso(null);
    setSubmitting(true);
    try {
      const payload = construirPayloadOnboarding(state);
      const res = await fetch('/.netlify/functions/onboarding-crear-gym', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo crear el gym.');
      const slug = data.slug as string;

      // Auto-login para poder cobrar (suscribir-saas usa el token del dueño).
      // Si falla, igual mostramos "listo" (puede cargar la tarjeta después).
      const { error: loginErr } = await supabase.auth.signInWithPassword({
        email: state.cuenta.email.trim().toLowerCase(),
        password: state.cuenta.password
      });
      if (loginErr) {
        setResultado({ slug });
        return;
      }
      // Paso de cobro real (tarjeta + 7 días de prueba) embebido en SALA.
      setPendienteCobro({ slug });
    } catch (e) {
      setErrorPaso(e instanceof Error ? e.message : 'Error inesperado. Prueba de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  if (resultado) {
    return <PasoListo state={state} slug={resultado.slug} />;
  }

  if (pendienteCobro && state.tier) {
    const irAListo = () => {
      setResultado({ slug: pendienteCobro.slug });
      setPendienteCobro(null);
    };
    return (
      <PasoCobroReal
        tier={state.tier}
        moneda={monedaPorTimezone(state.gym.timezone)}
        onListo={irAListo}
        onDespues={irAListo}
      />
    );
  }

  return (
    <div className="sala-brand" style={{ maxWidth: '520px', margin: '0 auto', padding: '40px 24px 80px', minHeight: '100vh' }}>
      <Link
        to="/"
        style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
      >
        <ArrowLeft size={14} strokeWidth={2.25} />
        Volver a SALA
      </Link>

      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: '24px 0 4px' }}>
        CREÁ TU GYM
      </p>
      <h1
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '28px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          margin: '0 0 20px'
        }}
      >
        {PASOS[paso]}
      </h1>

      <Progreso pasoActual={paso} />

      <div style={{ marginTop: '24px' }}>
        {paso === 0 && (
          <PasoCuenta
            value={state.cuenta}
            onChange={(cuenta) => setState((s) => ({ ...s, cuenta }))}
          />
        )}
        {paso === 1 && (
          <PasoGym
            value={state.gym}
            onChange={(gym) => setState((s) => ({ ...s, gym }))}
          />
        )}
        {paso === 2 && (
          <PasoPlan
            timezone={state.gym.timezone}
            tier={state.tier}
            onChange={(tier) => setState((s) => ({ ...s, tier }))}
          />
        )}
        {paso === 3 && state.tier && (
          <PasoPago tier={state.tier} timezone={state.gym.timezone} />
        )}
        {paso === 4 && (
          <PasoSetup
            value={state.setup}
            onChange={(setup) => setState((s) => ({ ...s, setup }))}
          />
        )}
      </div>

      {errorPaso && (
        <p className="ek-error-text" style={{ marginTop: '14px' }}>
          {errorPaso}
        </p>
      )}

      <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
        {paso > 0 && (
          <button
            type="button"
            onClick={retroceder}
            disabled={submitting}
            className="ek-cta ek-cta--secondary"
            style={{ flex: '0 0 auto' }}
          >
            Atrás
          </button>
        )}
        {paso === 0 && (
          <button type="button" className="ek-cta" style={{ flex: 1 }}
            onClick={() => avanzar(validarPasoCuenta(state.cuenta))}>
            Continuar
          </button>
        )}
        {paso === 1 && (
          <button type="button" className="ek-cta" style={{ flex: 1 }}
            onClick={() => avanzar(validarPasoGym(state.gym))}>
            Continuar
          </button>
        )}
        {paso === 2 && (
          <button type="button" className="ek-cta" style={{ flex: 1 }}
            onClick={() => avanzar(validarPasoPlan(state.tier))}>
            Continuar
          </button>
        )}
        {paso === 3 && (
          <button type="button" className="ek-cta" style={{ flex: 1 }}
            onClick={() => { setErrorPaso(null); setPaso(4); }}>
            Continuar
          </button>
        )}
        {paso === 4 && (
          <button type="button" className="ek-cta" style={{ flex: 1 }}
            onClick={crearGym} disabled={submitting}>
            {submitting ? 'Creando tu gym…' : 'Crear mi gym'}
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Indicador de progreso
// ============================================================================

function Progreso({ pasoActual }: { pasoActual: number }) {
  return (
    <div style={{ display: 'flex', gap: '6px' }}>
      {PASOS.map((label, i) => (
        <div key={label} style={{ flex: 1 }}>
          <div
            style={{
              height: '4px',
              borderRadius: '999px',
              background: i <= pasoActual ? 'var(--ek-mustard)' : 'var(--ek-line)'
            }}
          />
          <p
            style={{
              fontSize: '10px',
              fontWeight: 600,
              letterSpacing: '0.04em',
              color: i === pasoActual ? 'var(--ek-mustard)' : 'var(--ek-ink-faint)',
              margin: '6px 0 0',
              textAlign: 'center'
            }}
          >
            {label}
          </p>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Paso 1 — Cuenta
// ============================================================================

function PasoCuenta({
  value,
  onChange
}: {
  value: OnboardingState['cuenta'];
  onChange: (v: OnboardingState['cuenta']) => void;
}) {
  return (
    <div className="ek-stack-md">
      <p className="ek-body-muted" style={{ margin: 0 }}>
        Crea tu cuenta de dueño. Vas a administrar el gym con este acceso.
      </p>
      <Campo label="Tu nombre">
        <input
          type="text"
          className="ek-input"
          value={value.nombre}
          onChange={(e) => onChange({ ...value, nombre: e.target.value })}
          autoComplete="name"
        />
      </Campo>
      <Campo label="Email">
        <input
          type="email"
          className="ek-input"
          value={value.email}
          onChange={(e) => onChange({ ...value, email: e.target.value })}
          autoComplete="email"
        />
      </Campo>
      <Campo label="Confirmar email" hint="Escribilo de nuevo para evitar errores.">
        <input
          type="email"
          className="ek-input"
          value={value.emailConfirm}
          onChange={(e) => onChange({ ...value, emailConfirm: e.target.value })}
          autoComplete="email"
        />
      </Campo>
      <Campo label="Contraseña" hint="Mínimo 8 caracteres, con una letra y un número.">
        <input
          type="password"
          className="ek-input"
          value={value.password}
          onChange={(e) => onChange({ ...value, password: e.target.value })}
          autoComplete="new-password"
        />
      </Campo>
      <Campo label="Confirmar contraseña">
        <input
          type="password"
          className="ek-input"
          value={value.passwordConfirm}
          onChange={(e) => onChange({ ...value, passwordConfirm: e.target.value })}
          autoComplete="new-password"
        />
      </Campo>
    </div>
  );
}

// ============================================================================
// Paso 2 — Datos del gym
// ============================================================================

type Disponibilidad = 'idle' | 'checking' | 'disponible' | 'tomado' | 'invalido';

function PasoGym({
  value,
  onChange
}: {
  value: OnboardingState['gym'];
  onChange: (v: OnboardingState['gym']) => void;
}) {
  const [slugTocado, setSlugTocado] = useState(value.slug.length > 0);
  const [disp, setDisp] = useState<Disponibilidad>('idle');

  // Autosugerir slug desde el nombre del gym mientras no se haya tocado.
  function setNombre(gymNombre: string) {
    const next = { ...value, gymNombre };
    if (!slugTocado) next.slug = sugerirSubdominio(gymNombre);
    onChange(next);
  }

  // Chequeo de disponibilidad del slug (debounced).
  useEffect(() => {
    const slug = value.slug.trim().toLowerCase();
    const fmt = validarSubdominio(slug);
    if (!fmt.ok) {
      setDisp(slug ? 'invalido' : 'idle');
      return;
    }
    setDisp('checking');
    let cancelado = false;
    const t = setTimeout(async () => {
      // RPC slug_disponible (SECURITY DEFINER): ve TODOS los estados. Leer
      // `tenants` como anon solo veía los activos → falso "disponible" para
      // slugs de tenants suspendidos.
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        n: string, a: Record<string, unknown>
      ) => Promise<{ data: boolean | null; error: { message: string } | null }>;
      const { data, error } = await rpc('slug_disponible', { p_slug: slug });
      if (cancelado) return;
      // Si el RPC falla, no afirmamos "disponible" (el backend igual valida).
      setDisp(error ? 'idle' : data ? 'disponible' : 'tomado');
    }, 450);
    return () => {
      cancelado = true;
      clearTimeout(t);
    };
  }, [value.slug]);

  const dispMsg: Record<Disponibilidad, { texto: string; color: string; ok?: boolean } | null> = {
    idle: null,
    checking: { texto: 'Verificando…', color: 'var(--ek-ink-faint)' },
    disponible: { texto: 'Disponible', color: 'var(--sala-success)', ok: true },
    tomado: { texto: 'Ese subdominio ya está en uso', color: 'var(--sala-error)' },
    invalido: { texto: validarSubdominio(value.slug).error ?? 'Subdominio inválido', color: 'var(--sala-error)' }
  };
  const msg = dispMsg[disp];
  const hostEjemplo =
    typeof window !== 'undefined' ? window.location.host.replace(/^www\./, '') : 'salastudio.app';

  return (
    <div className="ek-stack-md">
      <Campo label="Nombre del gym">
        <input
          type="text"
          className="ek-input"
          value={value.gymNombre}
          onChange={(e) => setNombre(e.target.value)}
          placeholder="Ej: Yoga Sol"
        />
      </Campo>
      <Campo label="Subdominio" hint={`Tu gym vivirá en ${value.slug || 'tu-gym'}.${hostEjemplo}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <input
            type="text"
            className="ek-input"
            value={value.slug}
            onChange={(e) => {
              setSlugTocado(true);
              onChange({ ...value, slug: e.target.value.toLowerCase() });
            }}
            placeholder="yogasol"
            style={{ flex: 1 }}
          />
        </div>
        {msg && (
          <span style={{ fontSize: '12px', fontWeight: 600, color: msg.color, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            {msg.ok && <Check size={13} strokeWidth={2.5} />}
            {msg.texto}
          </span>
        )}
      </Campo>
      <Campo label="País / zona horaria" hint="Define tu moneda y la hora de tus clases.">
        <select
          className="ek-input"
          value={value.timezone}
          onChange={(e) => onChange({ ...value, timezone: e.target.value })}
        >
          {TIMEZONE_OPTIONS.map((tz) => (
            <option key={tz.value} value={tz.value}>
              {tz.label}
            </option>
          ))}
        </select>
      </Campo>
    </div>
  );
}

// ============================================================================
// Paso 3 — Plan
// ============================================================================

/** true cuando el viewport es angosto (<768px) → las cards se apilan. */
function useEsAngosto(): boolean {
  const [angosto, setAngosto] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = () => setAngosto(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return angosto;
}

function PasoPlan({
  timezone,
  tier,
  onChange
}: {
  timezone: string;
  tier: TierSaas | null;
  onChange: (t: TierSaas) => void;
}) {
  const moneda = useMemo(() => monedaPorTimezone(timezone), [timezone]);
  const angosto = useEsAngosto();

  return (
    <div className="ek-stack-md">
      <p className="ek-body-muted" style={{ margin: 0 }}>
        {TRIAL_DIAS} días de prueba gratis en cualquier plan. Cancelas cuando quieras.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: angosto ? '1fr' : 'repeat(3, 1fr)',
          gap: '10px',
          alignItems: 'stretch',
          marginTop: '8px'
        }}
      >
        {TIERS_ORDEN.map((t) => (
          <PlanColumna
            key={t}
            tier={t}
            moneda={moneda}
            seleccionado={tier === t}
            onSelect={() => onChange(t)}
          />
        ))}
      </div>
    </div>
  );
}

/** Card de un tier, pensada para grilla de 3 columnas de igual alto. */
function PlanColumna({
  tier,
  moneda,
  seleccionado,
  onSelect
}: {
  tier: TierSaas;
  moneda: MonedaSaas;
  seleccionado: boolean;
  onSelect: () => void;
}) {
  const plan = PLANES_SAAS[tier];
  const destacado = tier === 'pro';
  const borderColor = seleccionado || destacado ? 'var(--ek-mustard)' : 'var(--ek-line)';
  const borderWidth = seleccionado ? '2px' : destacado ? '1.5px' : '1px';

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={seleccionado}
      style={{
        position: 'relative',
        textAlign: 'left',
        background: seleccionado ? 'var(--ek-mustard-soft)' : 'var(--ek-bg-soft)',
        border: `${borderWidth} solid ${borderColor}`,
        borderRadius: 'var(--ek-r-card)',
        padding: '16px 12px 14px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        gap: '7px',
        height: '100%'
      }}
    >
      {destacado && (
        <span
          style={{
            position: 'absolute',
            top: '-9px',
            left: '50%',
            transform: 'translateX(-50%)',
            fontSize: '9px',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--ek-bg)',
            background: 'var(--ek-mustard)',
            padding: '3px 10px',
            borderRadius: '999px',
            whiteSpace: 'nowrap'
          }}
        >
          Más popular
        </span>
      )}

      {seleccionado && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '8px',
            right: '8px',
            width: '18px',
            height: '18px',
            borderRadius: '50%',
            background: 'var(--ek-mustard)',
            color: 'var(--ek-bg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <Check size={12} strokeWidth={3} />
        </span>
      )}

      <span style={{ fontFamily: 'var(--ek-font-display)', fontSize: '16px', fontWeight: 700 }}>
        {plan.nombre}
      </span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px', flexWrap: 'wrap' }}>
        <span
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 700,
            letterSpacing: '-0.02em'
          }}
        >
          {formatPrecio(precioCentavos(tier, moneda), moneda)}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>/mes</span>
      </div>
      <span style={{ fontSize: '11px', color: 'var(--ek-ink-muted)', lineHeight: 1.4 }}>
        {plan.resumen}
      </span>
      <ul
        style={{
          listStyle: 'none',
          margin: '2px 0 0',
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '5px'
        }}
      >
        {plan.features.map((f) => (
          <li
            key={f}
            style={{
              fontSize: '11px',
              display: 'flex',
              gap: '5px',
              lineHeight: 1.35,
              color: 'var(--ek-ink)'
            }}
          >
            <Check size={15} strokeWidth={2.5} style={{ color: 'var(--ek-mustard)', flexShrink: 0, marginTop: '1px' }} />
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}

// ============================================================================
// Paso 4 — Pago (review; la tarjeta se pide al final, embebida)
// ============================================================================

function PasoPago({ tier, timezone }: { tier: TierSaas; timezone: string }) {
  const moneda = monedaPorTimezone(timezone);
  const precioStr = `${formatPrecio(precioCentavos(tier, moneda), moneda)}/mes`;

  return (
    <div className="ek-stack-md">
      <p className="ek-body-muted" style={{ margin: 0 }}>
        Plan {PLANES_SAAS[tier].nombre}
      </p>
      <div
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-md)',
          padding: '14px 16px'
        }}
      >
        <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>
          {TRIAL_DIAS} días gratis
        </p>
        <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>
          Después, {precioStr}. Cancelás cuando quieras.
        </p>
      </div>
      <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, lineHeight: 1.5 }}>
        Te vamos a pedir la tarjeta al confirmar (pago seguro con Stripe). No se cobra nada durante la prueba;
        el primer cobro es al terminar los {TRIAL_DIAS} días.
      </p>
    </div>
  );
}

// ============================================================================
// Paso final — Cobro real (tarjeta + trial) embebido, tras crear el gym
// ============================================================================

function PasoCobroReal({
  tier,
  moneda,
  onListo,
  onDespues
}: {
  tier: TierSaas;
  moneda: MonedaSaas;
  onListo: () => void;
  onDespues: () => void;
}) {
  const plan = PLANES_SAAS[tier];
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="sala-brand" style={{ maxWidth: '520px', margin: '0 auto', padding: '40px 24px 80px', minHeight: '100vh' }}>
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: '0 0 4px' }}>ÚLTIMO PASO · PAGO SEGURO</p>
      <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '28px', fontWeight: 700, letterSpacing: '-0.03em', margin: '0 0 6px' }}>
        Activá tu plan {plan.nombre}
      </h1>
      <p className="ek-body-muted" style={{ margin: '0 0 20px' }}>
        {TRIAL_DIAS} días gratis. Después, {formatPrecio(precioCentavos(tier, moneda), moneda)}/mes.
      </p>
      {error ? (
        <p style={{ color: 'var(--sala-error)', fontSize: '14px', lineHeight: 1.5 }}>{error}</p>
      ) : (
        <CheckoutSaasEmbedded tier={tier} moneda={moneda} onComplete={onListo} onError={setError} />
      )}
      <button
        type="button"
        onClick={onDespues}
        style={{ marginTop: '20px', background: 'none', border: 'none', color: 'var(--ek-ink-muted)', fontSize: '13px', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' }}
      >
        Configurar el pago después
      </button>
    </div>
  );
}

// ============================================================================
// Paso 5 — Setup
// ============================================================================

function PasoSetup({
  value,
  onChange
}: {
  value: OnboardingState['setup'];
  onChange: (v: OnboardingState['setup']) => void;
}) {
  return (
    <div className="ek-stack-md">
      <p className="ek-body-muted" style={{ margin: 0 }}>
        Últimos toques. Puedes cambiar todo después desde el panel.
      </p>
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        <Campo label="Color primario">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <input
              type="color"
              value={value.colorPrimario}
              onChange={(e) => onChange({ ...value, colorPrimario: e.target.value })}
              style={{ width: '48px', height: '40px', border: 'none', background: 'none', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', fontFamily: 'var(--ek-font-mono)' }}>
              {value.colorPrimario}
            </span>
          </div>
        </Campo>
        <Campo label="Color de acento">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <input
              type="color"
              value={value.colorAcento}
              onChange={(e) => onChange({ ...value, colorAcento: e.target.value })}
              style={{ width: '48px', height: '40px', border: 'none', background: 'none', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', fontFamily: 'var(--ek-font-mono)' }}>
              {value.colorAcento}
            </span>
          </div>
        </Campo>
      </div>
      <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: 0 }}>
        El primario es tu color base; el acento es el toque que resalta detalles
        (planes destacados, estados, etc.). Si quieres, deja el acento igual al
        primario. El logo lo subes más tarde desde Ajustes › Marca.
      </p>
      <Campo label="Tu primera sala">
        <input
          type="text"
          className="ek-input"
          value={value.salaNombre}
          onChange={(e) => onChange({ ...value, salaNombre: e.target.value })}
          placeholder="Ej: Sala Principal"
        />
      </Campo>
      <Campo label="Cupo de la sala" hint="Cuántas personas entran por clase.">
        <input
          type="number"
          min={1}
          className="ek-input"
          value={value.salaCupo}
          onChange={(e) => onChange({ ...value, salaCupo: Math.floor(Number(e.target.value)) || 0 })}
        />
      </Campo>
    </div>
  );
}

// ============================================================================
// Paso final — Listo
// ============================================================================

function PasoListo({ state, slug }: { state: OnboardingState; slug: string }) {
  const url = urlDelGym(slug);
  const email = state.cuenta.email.trim().toLowerCase();
  return (
    <div style={{ maxWidth: '520px', margin: '0 auto', padding: '60px 24px', minHeight: '100vh' }}>
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: '0 0 8px' }}>
        TODO LISTO
      </p>
      <h1
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '32px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          margin: '0 0 12px'
        }}
      >
        ¡Tu gym está listo!
      </h1>
      <p className="ek-body-muted" style={{ margin: '0 0 24px' }}>
        Creamos <strong>{state.gym.gymNombre}</strong> con tu plan, tu primera sala
        y tu cuenta de administrador.
      </p>

      <div
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-card)',
          padding: '18px',
          marginBottom: '24px'
        }}
      >
        <Resumen label="Tu cuenta" valor={email} />
        <Resumen label="Gym" valor={state.gym.gymNombre} />
        <Resumen label="Plan" valor={state.tier ? PLANES_SAAS[state.tier].nombre : '—'} />
        <Resumen label="Sala" valor={`${state.setup.salaNombre} · cupo ${state.setup.salaCupo}`} />
        <Resumen label="Dirección" valor={`${slug}`} ultimo />
      </div>

      <a
        href={url}
        className="ek-cta ek-cta--full"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', textDecoration: 'none', padding: '16px' }}
      >
        Ir a mi gym
        <ArrowRight size={18} strokeWidth={2.25} />
      </a>
      <p
        style={{
          fontSize: '13px',
          color: 'var(--ek-ink-muted)',
          textAlign: 'center',
          marginTop: '12px',
          lineHeight: 1.5
        }}
      >
        Inicia sesión con <strong style={{ color: 'var(--ek-ink)' }}>{email}</strong> y la
        contraseña que registraste.
      </p>
    </div>
  );
}

// ============================================================================
// Helpers de UI
// ============================================================================

function Campo({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ek-form-field">
      <label className="ek-label">{label}</label>
      {children}
      {hint && (
        <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>{hint}</span>
      )}
    </div>
  );
}

function Resumen({ label, valor, ultimo }: { label: string; valor: string; ultimo?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '8px 0',
        borderBottom: ultimo ? 'none' : '0.5px solid var(--ek-line)'
      }}
    >
      <span style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: '13px', fontWeight: 600, textAlign: 'right' }}>{valor}</span>
    </div>
  );
}
