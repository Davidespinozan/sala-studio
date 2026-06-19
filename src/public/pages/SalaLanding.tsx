import { useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BarChart3,
  Building2,
  CalendarCheck,
  Check,
  Palette,
  QrCode,
  Search,
  Star,
  Users,
  X,
  type LucideIcon
} from 'lucide-react';
import { SalaLogo } from '@shared/components/SalaLogo';
import { BrowserFrame, PhoneFrame } from '../components/DeviceFrame';
import { Reveal } from '../components/Reveal';
import BuscarEstudio from '../components/BuscarEstudio';
import ProbarDemoModal from '../components/ProbarDemoModal';
import { demoDisponible } from '@shared/lib/demoAuth';
import {
  MONEDAS,
  PLANES_SAAS,
  TIERS_ORDEN,
  TRIAL_DIAS,
  monedaPorTimezone,
  type MonedaSaas
} from '@shared/lib/planesSaas';

/**
 * Capturas del producto (en public/shots/). Vacío → el marco muestra un
 * placeholder de marca. Llenar cuando estén las imágenes.
 */
const SHOTS = {
  agenda: '/shots/agenda.png',
  socio: '/shots/socio.png',
  checkin: '/shots/checkin.png',
  dashboard: '/shots/dashboard.png',
  mapa: '/shots/mapa.png',
  estudio: '/shots/estudio.png'
};
// Mientras no existan los archivos, mostramos placeholder (evita el ícono de
// imagen rota). Cuando subas las capturas, pon USAR_SHOTS = true.
const USAR_SHOTS = true;
const shot = (key: keyof typeof SHOTS): string | undefined => (USAR_SHOTS ? SHOTS[key] : undefined);

/**
 * Landing de PRODUCTO de SALA — le vende la plataforma a dueños de gimnasios
 * y estudios, y los lleva al onboarding self-service (/registro). Es distinta
 * de la landing per-tenant (Landing.tsx), que cada gym muestra a sus socios.
 *
 * Ruteada a nivel App (/para-gimnasios), fuera del PublicLayout per-tenant:
 * trae su propio header/footer y usa la marca SALA, no la del tenant.
 */

const REGISTRO = '/registro';

/** Acento elegante de SALA sobre fondos OSCUROS (sage claro). Reemplaza el oro
 *  (--sala-warning) que se veía amarillo y barato para una marca premium. */
const ACCENT_DARK = 'color-mix(in srgb, var(--sala-primary), white 58%)';

const FEATURES: Array<{ icon: LucideIcon; titulo: string; texto: string }> = [
  {
    icon: CalendarCheck,
    titulo: 'Reservas y agenda',
    texto: 'Tus clases y salas, con cupos, lista de espera y cancelaciones automáticas.'
  },
  {
    icon: Users,
    titulo: 'Socios y membresías',
    texto: 'Altas, planes, créditos y vencimientos. Todo el ciclo de tus miembros en un lugar.'
  },
  {
    icon: QrCode,
    titulo: 'Check-in con QR',
    texto: 'Cada socio tiene su QR. Recepción escanea y valida el acceso en segundos.'
  },
  {
    icon: Palette,
    titulo: 'Tu marca, tu app',
    texto: 'Tus colores, tu logo y tu dominio. Tus socios ven tu marca, no la nuestra.'
  },
  {
    icon: BarChart3,
    titulo: 'Reportes que importan',
    texto: 'Ocupación, retención y churn. Sabe qué clases funcionan y a quién estás perdiendo.'
  },
  {
    icon: Building2,
    titulo: 'Multi-sucursal',
    texto: 'Maneja varias sedes desde una sola cuenta, con su agenda y su equipo.'
  }
];

const PASOS: Array<{ n: string; titulo: string; texto: string }> = [
  { n: '01', titulo: 'Crea tu gym', texto: 'Regístrate en minutos: nombre, subdominio y tu primer plan.' },
  { n: '02', titulo: 'Configura tu marca', texto: 'Sube tu logo, elige tus colores, carga tus salas y membresías.' },
  { n: '03', titulo: 'Recibe reservas', texto: 'Comparte tu link y tus socios empiezan a reservar al instante.' }
];

const FAQS: Array<{ q: string; a: string }> = [
  { q: '¿Necesito conocimientos técnicos?', a: 'No. Configuras todo desde un panel visual, sin programar ni instalar nada.' },
  { q: '¿Mis socios tienen que bajar una app?', a: 'No. Es una web app instalable (PWA): la abren desde el navegador y la suman a su pantalla de inicio.' },
  { q: '¿Puedo usar mi propio dominio?', a: 'Sí, desde el plan Pro. Tu estudio vive en tu dominio, con tu marca.' },
  { q: '¿Puedo cambiar de plan después?', a: `Cuando quieras. Empiezas con ${TRIAL_DIAS} días gratis y ajustas según crezcas.` }
];

/**
 * Moneda de mercado del visitante, derivada de su zona horaria del navegador
 * (refleja su ubicación, sin llamada externa ni selección manual). Mismo
 * criterio que usa el onboarding: México→MXN · Europa→EUR · resto→USD.
 */
function detectarMoneda(): MonedaSaas {
  try {
    return monedaPorTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return 'usd';
  }
}

export default function SalaLanding() {
  const moneda = detectarMoneda();
  const [buscarOpen, setBuscarOpen] = useState(false);
  const abrirBuscar = () => setBuscarOpen(true);

  return (
    <div className="sala-brand" style={{ background: 'var(--sala-bg)', minHeight: '100vh' }}>
      <Header onBuscar={abrirBuscar} />
      <Hero />
      <TrustStrip />
      <Features />
      <Showcase />
      <Pasos />
      <Pricing moneda={moneda} />
      <Faq />
      <CtaFinal />
      <Footer onBuscar={abrirBuscar} />
      {buscarOpen && <BuscarEstudio onClose={() => setBuscarOpen(false)} />}
    </div>
  );
}

// ============================================================================
// Header
// ============================================================================

function Header({ onBuscar }: { onBuscar: () => void }) {
  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px clamp(16px, 5vw, 48px)',
        background: 'rgba(250, 250, 247, 0.82)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--sala-border)'
      }}
    >
      <Link to="/" style={{ display: 'inline-flex', textDecoration: 'none' }} aria-label="SALA Studio">
        <span className="sala-logo-full"><SalaLogo variant="completo" height={32} showStudio /></span>
        <span className="sala-logo-mark"><SalaLogo variant="isotipo" height={34} /></span>
      </Link>
      <nav style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <button
          type="button"
          onClick={onBuscar}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: '14px',
            fontWeight: 600,
            color: 'var(--sala-text-secondary)'
          }}
        >
          <Search size={15} strokeWidth={2.25} />
          Busca tu estudio
        </button>
        <Link to={REGISTRO} className="ek-cta ek-lift" style={{ padding: '10px 18px', minHeight: '40px', fontSize: '14px' }}>
          Crea tu gym
          <ArrowRight size={16} strokeWidth={2.25} />
        </Link>
      </nav>
    </header>
  );
}

// ============================================================================
// Hero (oscuro inmersivo)
// ============================================================================

/** CTA que abre el selector de rol del demo. Oculto si el demo no está
 *  configurado (sin env). */
function ProbarDemoButton() {
  const [open, setOpen] = useState(false);
  if (!demoDisponible()) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="sala-hero-cta sala-hero-cta--fill ek-lift"
      >
        Probar demo
      </button>
      {open && <ProbarDemoModal onClose={() => setOpen(false)} />}
    </>
  );
}

function Hero() {
  return (
    <section style={{ padding: 'clamp(16px, 5vw, 48px)' }}>
      <div
        className="sala-hero-immersive"
        style={{
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 'var(--ek-r-card)',
          padding: 'clamp(32px, 4.5vw, 60px) clamp(24px, 5vw, 56px)',
          boxShadow: '0 24px 60px rgba(10, 15, 12, 0.32)',
          textAlign: 'center'
        }}
      >
        {/* Capa 1 — mesh gradients flotantes (sage de SALA, tono sobre tono). */}
        <div className="sala-hero-mesh" aria-hidden="true" />
        {/* Capa 2 — orbs desenfocadas, delays desfasados (movimiento orgánico). */}
        <div className="sala-orb" aria-hidden="true" style={{ width: 300, height: 300, top: '-12%', left: '-6%', opacity: 0.12, animationDelay: '0s', '--orb-color': 'var(--sala-primary)' } as CSSProperties} />
        <div className="sala-orb" aria-hidden="true" style={{ width: 200, height: 200, bottom: '4%', right: '8%', opacity: 0.12, animationDelay: '3s', '--orb-color': ACCENT_DARK } as CSSProperties} />
        <div className="sala-orb" aria-hidden="true" style={{ width: 120, height: 120, top: '28%', right: '24%', opacity: 0.10, animationDelay: '6s', '--orb-color': 'var(--sala-primary)' } as CSSProperties} />
        <div className="sala-fade-up" style={{ position: 'relative', zIndex: 4, maxWidth: '1180px', margin: '0 auto' }}>
          <div className="sala-hero-grid" style={{ textAlign: 'left' }}>
            {/* Columna izquierda — copy */}
            <div>
              <p
                style={{
                  fontSize: '12px',
                  fontWeight: 700,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: ACCENT_DARK,
                  margin: '0 0 18px'
                }}
              >
                Plataforma para estudios y gimnasios
              </p>
              <h1
                style={{
                  fontFamily: 'var(--ek-font-display)',
                  fontSize: 'clamp(28px, 6vw, 56px)',
                  fontWeight: 700,
                  letterSpacing: '-0.04em',
                  lineHeight: 1.04,
                  margin: 0,
                  color: 'rgba(255, 255, 255, 0.97)'
                }}
              >
                Llena tus clases
                <br />
                <span style={{ color: 'color-mix(in srgb, var(--sala-primary), white 48%)' }}>
                  y automatizá tu negocio.
                </span>
              </h1>
              <p
                style={{
                  fontSize: 'clamp(16px, 2.2vw, 19px)',
                  lineHeight: 1.55,
                  color: 'rgba(255, 255, 255, 0.68)',
                  margin: '20px 0 0',
                  maxWidth: '520px'
                }}
              >
                Olvídate del Excel y del caos de WhatsApp. Automatiza tus reservas, membresías,
                check-ins y reportes con una plataforma personalizada con tu marca y tu dominio propio.
              </p>
              <div className="sala-hero-ctas" style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginTop: '32px' }}>
                <ProbarDemoButton />
                <Link
                  to={REGISTRO}
                  className="sala-hero-cta sala-hero-cta--outline ek-lift sala-hero-cta-primary"
                >
                  Crea tu gym
                  <ArrowRight size={18} strokeWidth={2.25} />
                </Link>
                <a href="#precios" className="sala-hero-cta sala-hero-cta--ghost ek-lift">
                  Ver precios
                </a>
              </div>
              <p style={{ fontSize: '13px', color: 'rgba(255, 255, 255, 0.5)', margin: '18px 0 0' }}>
                {TRIAL_DIAS} días gratis · sin tarjeta · cancela cuando quieras
              </p>
            </div>

            {/* Columna derecha — el producto */}
            <div className="sala-hero-media" style={{ minWidth: 0 }}>
              <BrowserFrame src={shot('agenda')} alt="Agenda y reservas en SALA" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Franja de confianza
// ============================================================================

function TrustStrip() {
  const items = ['Sin instalar nada', 'Tu marca y tu dominio', 'Datos seguros', 'Soporte en español'];
  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '8px clamp(16px, 5vw, 48px) 0' }}>
      <div className="sala-trust-strip">
        {items.map((i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 600, color: 'var(--sala-text-secondary)' }}>
            <Check size={15} strokeWidth={2.5} style={{ color: 'var(--sala-primary)', flexShrink: 0 }} />
            {i}
          </span>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Features
// ============================================================================

function Features() {
  // La descripción vive en un popout: la card muestra ícono + título, y al
  // tocarla se abre el detalle. En móvil las cards son un carrusel scrolleable.
  const [abierto, setAbierto] = useState<number | null>(null);
  return (
    <section className="sala-band sala-section-features">
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 clamp(16px, 5vw, 48px)' }}>
        <SectionEyebrow label="Todo lo que necesitas" />
        <h2 style={sectionTitle}>Una plataforma, no diez herramientas sueltas.</h2>
        <div className="sala-features-track">
          {FEATURES.map((f, i) => {
            const Icon = f.icon;
            return (
              <button
                key={f.titulo}
                type="button"
                className="sala-feature-tile"
                onClick={() => setAbierto(i)}
                aria-label={`Ver detalle de ${f.titulo}`}
              >
                <span className="sala-feature-icon" aria-hidden="true">
                  <Icon size={20} strokeWidth={2} style={{ color: 'var(--sala-primary)' }} />
                </span>
                <span className="sala-feature-tile-title">{f.titulo}</span>
                <span className="sala-feature-tile-more">
                  Ver más
                  <ArrowRight size={14} strokeWidth={2.5} />
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {abierto !== null &&
        createPortal(
          <FeaturePopout f={FEATURES[abierto]} onClose={() => setAbierto(null)} />,
          document.body
        )}
    </section>
  );
}

/** Popout con el detalle de un feature (ícono + título + descripción). */
function FeaturePopout({
  f,
  onClose
}: {
  f: { icon: LucideIcon; titulo: string; texto: string };
  onClose: () => void;
}) {
  const Icon = f.icon;
  return (
    <div
      className="sala-brand"
      role="dialog"
      aria-modal="true"
      aria-label={f.titulo}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(10, 15, 12, 0.55)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '420px',
          background: 'var(--sala-surface)',
          borderRadius: '18px',
          boxShadow: '0 24px 60px rgba(10, 15, 12, 0.32)',
          padding: '24px',
          position: 'relative'
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar"
          style={{
            position: 'absolute',
            top: '14px',
            right: '14px',
            display: 'inline-flex',
            padding: '6px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--sala-text-tertiary)'
          }}
        >
          <X size={18} strokeWidth={2.25} />
        </button>
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            width: '48px',
            height: '48px',
            borderRadius: '13px',
            background: 'var(--sala-primary-light)',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '14px'
          }}
        >
          <Icon size={24} strokeWidth={2} style={{ color: 'var(--sala-primary)' }} />
        </span>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            margin: '0 0 8px',
            color: 'var(--sala-text-primary)'
          }}
        >
          {f.titulo}
        </h3>
        <p style={{ fontSize: '15px', lineHeight: 1.55, color: 'var(--sala-text-secondary)', margin: 0 }}>
          {f.texto}
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Showcase del producto
// ============================================================================

function ShowcaseRow({
  eyebrow,
  titulo,
  texto,
  media,
  reverse = false
}: {
  eyebrow: string;
  titulo: string;
  texto: string;
  media: React.ReactNode;
  reverse?: boolean;
}) {
  return (
    <div className={`sala-showcase-row${reverse ? ' reverse' : ''}`}>
      <div>
        {/* Sobre el verde oscuro: eyebrow sage claro + título blanco. */}
        <p
          style={{
            fontSize: '12px',
            fontWeight: 700,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: ACCENT_DARK,
            margin: 0
          }}
        >
          {eyebrow}
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(24px, 3.4vw, 34px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.12,
            margin: '10px 0 0',
            color: 'rgba(255, 255, 255, 0.97)',
            maxWidth: '460px'
          }}
        >
          {titulo}
        </h3>
        <p style={{ fontSize: '16px', lineHeight: 1.55, color: 'rgba(255, 255, 255, 0.66)', margin: '14px 0 0', maxWidth: '440px' }}>
          {texto}
        </p>
      </div>
      <div className="sala-showcase-media" style={{ minWidth: 0, display: 'flex', justifyContent: 'center' }}>
        {media}
      </div>
    </div>
  );
}

function Showcase() {
  return (
    <section className="sala-showcase-band">
      <div
        style={{
          padding: 'clamp(40px, 7vw, 80px) clamp(16px, 5vw, 48px)',
          maxWidth: '1280px',
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 'clamp(48px, 8vw, 96px)'
        }}
      >
      <Reveal>
        <ShowcaseRow
          reverse
          eyebrow="Tu web, tu marca"
          titulo="Tu propia web, con tu cara."
          texto="Tu hero, tus salas, tus instructores y tus planes — en tu dominio y con tu marca. Tus socios llegan a una página que es 100% tuya y reservan al instante. La nuestra no aparece por ningún lado."
          media={
            <BrowserFrame
              src={shot('estudio')}
              video={{ webm: '/shots/estudio-hero.webm', mp4: '/shots/estudio-hero.mp4' }}
              alt="Landing pública del gym con su propia marca y hero rotativo"
            />
          }
        />
      </Reveal>
      <Reveal>
        <ShowcaseRow
          eyebrow="Para tus socios"
          titulo="Tu app, en el bolsillo de cada socio."
          texto="Reservan, entran a lista de espera y muestran su QR desde el celular. Sin descargar nada: es una web app instalable con tu marca."
          media={<PhoneFrame src={shot('socio')} alt="App del socio reservando una clase" />}
        />
      </Reveal>
      <Reveal>
        <ShowcaseRow
          reverse
          eyebrow="Para tu recepción"
          titulo="Check-in con QR. Cero filas, cero planillas."
          texto="Cada socio llega con su código. Recepción escanea, valida el acceso y registra la asistencia en segundos — todo queda en la ficha."
          media={<BrowserFrame src={shot('checkin')} alt="Check-in con QR en recepción" />}
        />
      </Reveal>
      <Reveal>
        <ShowcaseRow
          eyebrow="Para ti, el dueño"
          titulo="Sabe qué clases llenan y a quién estás perdiendo."
          texto="Ocupación, asistencia, retención y churn en un panel claro. Dejas de adivinar y empiezas a decidir con datos."
          media={<BrowserFrame src={shot('dashboard')} alt="Dashboard con métricas de retención" />}
        />
      </Reveal>
      <Reveal>
        <ShowcaseRow
          reverse
          eyebrow="Mapa de salón"
          titulo="Cada socio elige su lugar."
          texto="Diseñas tu salón —bicis, mats o reformers— y cada socio reserva su lugar exacto desde la app. Recepción ve quién va dónde y reacomoda en segundos. El detalle premium que un estudio boutique merece."
          media={<PhoneFrame src={shot('mapa')} alt="Socio eligiendo su lugar en el Mapa de Salón" />}
        />
      </Reveal>
      </div>
    </section>
  );
}

// ============================================================================
// Cómo funciona
// ============================================================================

function Pasos() {
  return (
    <section className="sala-band">
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 clamp(16px, 5vw, 48px)' }}>
        <SectionEyebrow label="Cómo funciona" />
        <h2 style={sectionTitle}>De cero a recibiendo reservas en una tarde.</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
            gap: '16px',
            marginTop: '32px'
          }}
        >
          {PASOS.map((p, i) => (
            <Reveal
              key={p.n}
              delay={((i % 3) + 1) as 1 | 2 | 3}
              style={{ display: 'flex', gap: '13px', alignItems: 'flex-start' }}
            >
              <span
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  width: '40px',
                  height: '40px',
                  borderRadius: '12px',
                  background: 'var(--sala-primary-light)',
                  color: 'var(--sala-primary)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--ek-font-display)',
                  fontSize: '16px',
                  fontWeight: 700,
                  letterSpacing: '-0.02em'
                }}
              >
                {p.n}
              </span>
              <div style={{ minWidth: 0 }}>
                <h3
                  style={{
                    fontFamily: 'var(--ek-font-display)',
                    fontSize: '17px',
                    fontWeight: 700,
                    letterSpacing: '-0.02em',
                    margin: '2px 0 4px',
                    color: 'var(--sala-text-primary)'
                  }}
                >
                  {p.titulo}
                </h3>
                <p style={{ fontSize: '14px', lineHeight: 1.5, color: 'var(--sala-text-secondary)', margin: 0 }}>
                  {p.texto}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Precios
// ============================================================================

function Pricing({ moneda }: { moneda: MonedaSaas }) {
  const info = MONEDAS.find((m) => m.codigo === moneda) ?? MONEDAS[0];
  const [anual, setAnual] = useState(false);
  // MXN usa "$", que se confunde con USD → lo desambiguamos con el sufijo.
  const fmt = (n: number) =>
    moneda === 'mxn'
      ? `$${n.toLocaleString('es-MX')} MXN`
      : `${info.simbolo}${n.toLocaleString('es-MX')}`;

  return (
    <section id="precios" style={{ padding: 'clamp(32px, 6vw, 64px) clamp(16px, 5vw, 48px)', maxWidth: '1100px', margin: '0 auto' }}>
      <SectionEyebrow label="Precios" />
      <h2 style={sectionTitle}>Un plan para cada etapa.</h2>

      {/* Toggle mensual / anual (2 meses gratis). */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '20px', padding: '4px', borderRadius: '999px', background: 'var(--sala-surface)', border: '1px solid var(--sala-border)' }}>
        {[
          { v: false, label: 'Mensual' },
          { v: true, label: 'Anual' }
        ].map((opt) => {
          const active = anual === opt.v;
          return (
            <button
              key={opt.label}
              type="button"
              onClick={() => setAnual(opt.v)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '8px 16px',
                borderRadius: '999px',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: '13px',
                fontWeight: 600,
                background: active ? 'var(--sala-primary)' : 'transparent',
                color: active ? 'var(--sala-primary-text)' : 'var(--sala-text-secondary)'
              }}
            >
              {opt.label}
              {opt.v && (
                <span style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.04em', color: active ? 'var(--sala-primary-text)' : 'var(--sala-primary)' }}>
                  2 MESES GRATIS
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
          gap: '16px',
          marginTop: '28px',
          alignItems: 'stretch'
        }}
      >
        {TIERS_ORDEN.map((tier) => {
          const plan = PLANES_SAAS[tier];
          const destacado = tier === 'pro';
          const mensual = plan.precios[moneda];
          return (
            <div
              key={tier}
              className="ek-card"
              style={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                background: destacado
                  ? 'var(--grad-immersive)'
                  : 'var(--sala-surface)',
                border: destacado ? '1px solid rgba(255,255,255,0.1)' : '1px solid var(--sala-border)',
                boxShadow: destacado ? '0 12px 32px rgba(10,15,12,0.24)' : undefined
              }}
            >
              {destacado && (
                <span
                  style={{
                    position: 'absolute',
                    top: '16px',
                    right: '16px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '4px 10px',
                    borderRadius: '999px',
                    background: 'rgba(255,255,255,0.1)',
                    border: '1px solid rgba(255,255,255,0.16)',
                    color: ACCENT_DARK,
                    fontSize: '10px',
                    fontWeight: 800,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase'
                  }}
                >
                  <Star size={11} strokeWidth={2.5} fill="currentColor" /> Recomendado
                </span>
              )}
              <h3
                style={{
                  fontSize: '12px',
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  margin: 0,
                  color: destacado ? 'rgba(255,255,255,0.6)' : 'var(--sala-text-secondary)'
                }}
              >
                {plan.nombre}
              </h3>
              <p style={{ fontSize: '13px', margin: '4px 0 0', color: destacado ? 'rgba(255,255,255,0.55)' : 'var(--sala-text-tertiary)' }}>
                {plan.resumen}
              </p>
              <div style={{ margin: '16px 0 0' }}>
                <p
                  style={{
                    fontFamily: 'var(--ek-font-display)',
                    fontSize: '38px',
                    fontWeight: 700,
                    letterSpacing: '-0.03em',
                    margin: 0,
                    color: destacado ? 'rgba(255,255,255,0.97)' : 'var(--sala-text-primary)'
                  }}
                >
                  {anual ? fmt(mensual * 10) : fmt(mensual)}
                  <span style={{ fontSize: '14px', fontWeight: 500, color: destacado ? 'rgba(255,255,255,0.5)' : 'var(--sala-text-tertiary)' }}>
                    {' '}{anual ? '/año' : '/mes'}
                  </span>
                </p>
                {anual && (
                  <p style={{ fontSize: '12px', margin: '4px 0 0', color: destacado ? 'rgba(255,255,255,0.55)' : 'var(--sala-text-tertiary)' }}>
                    ≈ {fmt(Math.round((mensual * 10) / 12))}/mes · facturado anual
                  </p>
                )}
              </div>

              <ul style={{ listStyle: 'none', margin: '18px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '9px', flex: 1 }}>
                {plan.features.map((f) => (
                  <li
                    key={f}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '9px',
                      fontSize: '14px',
                      color: destacado ? 'rgba(255,255,255,0.85)' : 'var(--sala-text-primary)'
                    }}
                  >
                    <Check size={16} strokeWidth={2.5} style={{ color: destacado ? ACCENT_DARK : 'var(--sala-primary)', flexShrink: 0, marginTop: '1px' }} />
                    {f}
                  </li>
                ))}
              </ul>

              <Link
                to={`${REGISTRO}?plan=${tier}`}
                className={destacado ? 'ek-cta ek-lift ek-cta--full' : 'ek-cta ek-cta--secondary ek-lift ek-cta--full'}
                style={{ marginTop: '22px' }}
              >
                Empezar con {plan.nombre}
                <ArrowRight size={16} strokeWidth={2.25} />
              </Link>
            </div>
          );
        })}
      </div>

      <p style={{ textAlign: 'center', fontSize: '13px', color: 'var(--sala-text-tertiary)', margin: '20px 0 0' }}>
        {TRIAL_DIAS} días gratis. Cancelas cuando quieras.
      </p>
    </section>
  );
}

// ============================================================================
// FAQ
// ============================================================================

function Faq() {
  return (
    <section style={{ padding: 'clamp(32px, 6vw, 64px) clamp(16px, 5vw, 48px)', maxWidth: '760px', margin: '0 auto' }}>
      <SectionEyebrow label="Preguntas frecuentes" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '24px' }}>
        {FAQS.map((f) => (
          <FaqItem key={f.q} q={f.q} a={f.a} />
        ))}
      </div>
    </section>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ek-card" style={{ padding: 0, overflow: 'hidden', border: '1px solid var(--sala-border)' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '18px 20px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left'
        }}
      >
        <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--sala-text-primary)' }}>{q}</span>
        <span
          aria-hidden="true"
          style={{
            flexShrink: 0,
            fontSize: '22px',
            lineHeight: 1,
            color: 'var(--sala-primary)',
            transition: 'transform 0.2s ease',
            transform: open ? 'rotate(45deg)' : 'rotate(0deg)'
          }}
        >
          +
        </span>
      </button>
      {open && (
        <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', lineHeight: 1.55, margin: 0, padding: '0 20px 18px' }}>
          {a}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// CTA final
// ============================================================================

function CtaFinal() {
  return (
    <section style={{ padding: 'clamp(16px, 5vw, 48px)' }}>
      <div
        className="sala-cta-immersive"
        style={{
          maxWidth: '900px',
          margin: '0 auto',
          textAlign: 'center',
          borderRadius: 'var(--ek-r-card)',
          padding: 'clamp(40px, 6vw, 72px) clamp(24px, 5vw, 48px)',
          boxShadow: '0 24px 60px rgba(10, 15, 12, 0.32)'
        }}
      >
        <h2
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(28px, 5vw, 44px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
            margin: 0,
            color: 'rgba(255, 255, 255, 0.97)'
          }}
        >
          Empieza hoy. Tu primer socio reserva esta semana.
        </h2>
        <Link
          to={REGISTRO}
          className="sala-hero-cta sala-hero-cta--fill ek-lift"
          style={{ marginTop: '28px' }}
        >
          Crea tu gym
          <ArrowRight size={18} strokeWidth={2.25} />
        </Link>
      </div>
    </section>
  );
}

// ============================================================================
// Footer
// ============================================================================

function Footer({ onBuscar }: { onBuscar: () => void }) {
  const linkStyle: CSSProperties = {
    fontSize: '13px',
    color: 'var(--sala-text-secondary)',
    textDecoration: 'none',
    display: 'block',
    padding: '3px 0'
  };
  return (
    <footer style={{ borderTop: '1px solid var(--sala-border)', marginTop: 'clamp(24px, 5vw, 48px)' }}>
      <div
        style={{
          maxWidth: '1100px',
          margin: '0 auto',
          padding: 'clamp(32px, 5vw, 48px) clamp(16px, 5vw, 48px) 24px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
          gap: '32px'
        }}
      >
        <div>
          <SalaLogo variant="completo" height={30} showStudio />
          <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', margin: '14px 0 0', maxWidth: '300px', lineHeight: 1.55 }}>
            La plataforma para estudios y gimnasios boutique. Tu marca, tu app, tus reglas.
          </p>
        </div>
        <div>
          <p className="ek-eyebrow" style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)', margin: '0 0 8px' }}>PRODUCTO</p>
          <a href="#precios" style={linkStyle}>Precios</a>
          <Link to={REGISTRO} style={linkStyle}>Crea tu gym</Link>
          <button
            type="button"
            onClick={onBuscar}
            style={{ ...linkStyle, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', padding: '3px 0' }}
          >
            Busca tu estudio
          </button>
        </div>
        <div>
          <p className="ek-eyebrow" style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)', margin: '0 0 8px' }}>CONTACTO</p>
          <a href="mailto:hola@salastudio.app" style={linkStyle}>hola@salastudio.app</a>
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--sala-border)' }}>
        <p style={{ maxWidth: '1100px', margin: '0 auto', padding: '16px clamp(16px, 5vw, 48px)', fontSize: '12px', color: 'var(--sala-text-tertiary)' }}>
          © 2026 SALA Studio · Hecho en LATAM
        </p>
      </div>
    </footer>
  );
}

// ============================================================================
// Helpers de estilo
// ============================================================================

const sectionTitle: React.CSSProperties = {
  fontFamily: 'var(--ek-font-display)',
  fontSize: 'clamp(26px, 4vw, 36px)',
  fontWeight: 700,
  letterSpacing: '-0.03em',
  lineHeight: 1.12,
  margin: '10px 0 0',
  color: 'var(--sala-text-primary)',
  maxWidth: '620px'
};

function SectionEyebrow({ label }: { label: string }) {
  return (
    <p
      style={{
        fontSize: '12px',
        fontWeight: 700,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color: 'var(--sala-primary)',
        margin: 0
      }}
    >
      {label}
    </p>
  );
}
