import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, Check, Dumbbell, Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import {
  useLandingConfig,
  type LandingPostHero,
  type PostHeroItem,
  type LandingHero,
  type LandingSeccionHeading
} from '@shared/hooks/useLandingConfig';
import { useTenant } from '@shared/hooks/useTenant';
import EstudioModal, { type EstudioInfo } from '../components/EstudioModal';
import Footer from '../components/Footer';
import { MagneticButton } from '@shared/components/MagneticButton';
import { HeroCarousel } from '@shared/components/HeroCarousel';
import { useSpotlight } from '@shared/hooks/useSpotlight';

interface EstudioPublico {
  id: string;
  slug: string;
  nombre: string;
  descripcion: string | null;
  tiers_permitidos: string[];
  tipo_contenido: string[] | null;
  equipo_incluido: string[] | null;
  estilo_visual: string | null;
  capacidad_personas: number | null;
  foto_url: string | null;
}

interface TierPublico {
  slug: string;
  nombre: string;
  precio_centavos: number;
  moneda: string;
  periodo: string;
  descripcion: string | null;
  beneficios: unknown;
  reglas: Record<string, unknown> | null;
  orden: number;
}

function useEstudiosPublicos() {
  const tenant = useTenant();
  const [estudios, setEstudios] = useState<EstudioPublico[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      // El filtro tenant_id es la PRIMERA línea de defensa para lecturas
      // anónimas: la RLS read_public no puede scopear por tenant (anon no
      // tiene JWT, get_my_tenant_id() es NULL). Sin este filtro, la landing
      // de un gym mostraría salas de otros tenants.
      const { data, error } = await supabase
        .from('recursos')
        .select(
          'id, slug, nombre, descripcion, tiers_permitidos, tipo_contenido, equipo_incluido, estilo_visual, capacidad_personas, foto_url'
        )
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('orden', { ascending: true });

      if (!mounted) return;
      if (error) console.error('[useEstudiosPublicos]', error);
      else setEstudios((data ?? []) as EstudioPublico[]);
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [tenant.id]);

  return { estudios, isLoading };
}

function useTiersPublicos() {
  const tenant = useTenant();
  const [tiers, setTiers] = useState<TierPublico[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      // El filtro tenant_id es la PRIMERA línea de defensa para lecturas
      // anónimas: la RLS read_public no puede scopear por tenant (anon no
      // tiene JWT, get_my_tenant_id() es NULL). Sin este filtro, la landing
      // de un gym mostraría planes de otros tenants.
      const { data, error } = await supabase
        .from('tiers')
        .select('slug, nombre, precio_centavos, moneda, periodo, descripcion, beneficios, reglas, orden')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('orden', { ascending: true });

      if (!mounted) return;
      if (error) console.error('[useTiersPublicos]', error);
      else setTiers((data ?? []) as TierPublico[]);
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [tenant.id]);

  return { tiers, isLoading };
}

interface InstructorPublico {
  id: string;
  nombre: string;
  bio: string | null;
  foto_url: string | null;
  especialidades: string[];
}

/** S6-5: instructores activos del tenant para la sección de la landing. */
function useInstructoresPublicos() {
  const tenant = useTenant();
  const [instructores, setInstructores] = useState<InstructorPublico[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from('instructores')
        .select('id, nombre, bio, foto_url, especialidades')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('orden', { ascending: true })
        .order('nombre', { ascending: true });

      if (!mounted) return;
      if (error) console.error('[useInstructoresPublicos]', error);
      else setInstructores((data ?? []) as InstructorPublico[]);
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [tenant.id]);

  return { instructores, isLoading };
}

/** Tile retrato compacto de instructor: la foto domina, nombre + especialidad
 *  sobre un scrim. Moderno y de poco espacio. */
function InstructorLandingCard({ instructor }: { instructor: InstructorPublico }) {
  const inicial =
    instructor.nombre
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '?';

  return (
    <div
      className="ek-lift"
      style={{
        position: 'relative',
        aspectRatio: '3 / 4',
        borderRadius: 'var(--ek-r-sm)',
        overflow: 'hidden',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        background: 'var(--grad-immersive)',
        boxShadow: '0 8px 22px rgba(10, 15, 12, 0.18)'
      }}
    >
      {instructor.foto_url ? (
        <img
          src={instructor.foto_url}
          alt={instructor.nombre}
          loading="lazy"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(36px, 8vw, 52px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            color: 'rgba(255, 255, 255, 0.9)',
            opacity: 0.85
          }}
        >
          {inicial}
        </div>
      )}

      {/* Scrim inferior para legibilidad del texto */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(to top, rgba(10, 15, 12, 0.88) 0%, rgba(10, 15, 12, 0.15) 42%, transparent 68%)',
          pointerEvents: 'none'
        }}
      />

      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '14px' }}>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '16px',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            lineHeight: 1.15,
            margin: 0,
            color: 'rgba(255, 255, 255, 0.97)'
          }}
        >
          {instructor.nombre}
        </h3>
        {instructor.especialidades.length > 0 && (
          <p
            style={{
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'rgba(255, 255, 255, 0.9)',
              margin: '5px 0 0',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {instructor.especialidades.join(' · ')}
          </p>
        )}
      </div>
    </div>
  );
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

// ── Sección post-hero: 3 variantes visuales del mismo contenido ──────────────
/**
 * Hero de la landing, reutilizable (lo usa la Landing real y el preview en vivo
 * del admin). Con `preview` true, el full-bleed llena el contenedor (en vez de
 * romper a 100vw) y las alturas se acotan para el panel.
 */
export function HeroView({
  hero,
  preview = false,
  forceMobile = false
}: {
  hero: LandingHero;
  preview?: boolean;
  /** En el preview móvil del admin, fuerza la imagen 3:4 del hero. */
  forceMobile?: boolean;
}) {
  const onSpotlight = useSpotlight();
  // Slides del carrusel: los configurados o, si no hay, la imagen única (compat).
  // Una sola → el carrusel hace solo Ken Burns.
  const slides = hero.imagenes.length > 0
    ? hero.imagenes
    : (hero.image_url || hero.image_url_mobile)
      ? [{ desktop: hero.image_url || hero.image_url_mobile, mobile: hero.image_url_mobile || hero.image_url }]
      : [];
  const hasImg = slides.length > 0;
  const tituloColor = hasImg ? 'rgba(255, 255, 255, 0.98)' : 'var(--sala-text-primary)';
  const subColor = hasImg ? 'rgba(255, 255, 255, 0.88)' : 'var(--ek-ink-muted)';
  // Sobre imagen, el acento va en un tono CLARO de la marca (el primary
  // oscuro era casi ilegible sobre la foto).
  // Acento del hero en DORADO (acento del tenant). Sobre foto, un toque más
  // claro para que resalte; antes era primary+blanco (verde lavado/gris).
  const accentColor = hasImg
    ? 'color-mix(in srgb, var(--sala-accent), white 14%)'
    : 'var(--sala-accent)';

  const inner = (
    <>
      {hero.eyebrow && (
        <p
          className="ek-eyebrow ek-eyebrow--mustard"
          style={{ marginBottom: '20px', ...(hasImg ? { color: 'rgba(255, 255, 255, 0.72)' } : {}) }}
        >
          {hero.eyebrow}
        </p>
      )}
      <h1 style={{
        fontFamily: 'var(--ek-font-display)',
        fontSize: 'clamp(42px, 8.5vw, 80px)',
        fontWeight: 700,
        letterSpacing: '-0.04em',
        lineHeight: 0.98,
        margin: 0,
        marginBottom: '24px',
        color: tituloColor,
        textShadow: hasImg ? '0 2px 24px rgba(10, 15, 12, 0.45)' : 'none'
      }}>
        {hero.titulo}
        {hero.titulo_accent && (
          <>
            {hero.titulo && <br />}
            <span style={{ color: accentColor }}>{hero.titulo_accent}</span>
          </>
        )}
      </h1>
      {hero.subtitulo && (
        <p style={{
          fontSize: 'clamp(16px, 2vw, 20px)',
          color: subColor,
          maxWidth: '600px',
          lineHeight: 1.5,
          marginBottom: '40px'
        }}>
          {hero.subtitulo}
        </p>
      )}
      <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center' }}>
        {preview ? (
          <a
            href={hero.cta_link || '#membresias'}
            className="ek-cta ek-lift"
            style={{ padding: hasImg ? '17px 34px' : '16px 28px', fontSize: '16px', display: 'inline-flex', alignItems: 'center' }}
          >
            {hero.cta_texto}
          </a>
        ) : (
          <MagneticButton
            href={hero.cta_link || '#membresias'}
            className="ek-cta"
            style={{ padding: hasImg ? '17px 34px' : '16px 28px', fontSize: '16px' }}
          >
            {hero.cta_texto}
          </MagneticButton>
        )}
        {hero.cta2_texto && (
          <a
            href={hero.cta2_link || '#membresias'}
            className="ek-lift"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: hasImg ? '17px 30px' : '16px 26px',
              fontSize: '16px',
              fontWeight: 600,
              borderRadius: '999px',
              textDecoration: 'none',
              background: hasImg ? 'rgba(255, 255, 255, 0.10)' : 'transparent',
              border: `1px solid ${hasImg ? 'rgba(255, 255, 255, 0.5)' : 'var(--sala-border-strong)'}`,
              color: hasImg ? 'rgba(255, 255, 255, 0.96)' : 'var(--sala-text-primary)',
              backdropFilter: hasImg ? 'blur(6px)' : undefined,
              WebkitBackdropFilter: hasImg ? 'blur(6px)' : undefined
            }}
          >
            {hero.cta2_texto}
          </a>
        )}
      </div>
    </>
  );

  // Estilo del hero con imagen, elegible desde admin:
  //   'completo'  → full-bleed de borde a borde (rompe el contenedor 1200)
  //   'contenido' → card con esquinas redondeadas flotando sobre el fondo
  const fullBleed = hero.layout === 'completo';

  if (!hasImg) {
    return (
      <section
        className="sala-spotlight-host"
        onMouseMove={onSpotlight}
        style={{
          minHeight: preview ? '420px' : '90vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          position: 'relative',
          overflow: 'hidden',
          padding: '40px 0'
        }}
      >
        {/* Capa 1 — mesh gradients flotantes (primario + acento de marca). */}
        <div className="sala-hero-mesh" aria-hidden="true" />
        {/* Capa 2 — orbs desenfocadas con delays desfasados. */}
        <div className="sala-orb" aria-hidden="true" style={{ width: 320, height: 320, top: '-8%', right: '-6%', animationDelay: '0s', '--orb-color': 'var(--sala-primary)' } as CSSProperties} />
        <div className="sala-orb" aria-hidden="true" style={{ width: 200, height: 200, bottom: '2%', left: '-4%', animationDelay: '3s', '--orb-color': 'var(--sala-accent)' } as CSSProperties} />
        <div className="sala-orb" aria-hidden="true" style={{ width: 120, height: 120, top: '24%', left: '30%', animationDelay: '6s', '--orb-color': 'var(--sala-primary)' } as CSSProperties} />
        {/* Glow ambiental que sigue el cursor (desktop). */}
        <div className="sala-spotlight" aria-hidden="true" />
        <div className="sala-fade-up" style={{ position: 'relative', zIndex: 4 }}>
          {inner}
        </div>
      </section>
    );
  }

  return (
    <section
      style={
        fullBleed && !preview
          ? { padding: 0, width: '100vw', marginLeft: 'calc(50% - 50vw)' }
          : fullBleed
            ? { padding: 0 }
            : { padding: '40px 0' }
      }
    >
      <div
        className="landing-hero-card sala-spotlight-host"
        onMouseMove={onSpotlight}
        style={{
          position: 'relative',
          overflow: 'hidden',
          borderRadius: fullBleed ? 0 : 'var(--ek-r-card)',
          minHeight: preview
            ? (fullBleed ? '460px' : '420px')
            : (fullBleed ? 'clamp(560px, 92vh, 760px)' : 'clamp(520px, 80vh, 600px)'),
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          padding: fullBleed ? 0 : 'clamp(28px, 5vw, 56px)',
          boxShadow: fullBleed ? 'none' : '0 24px 60px rgba(10, 15, 12, 0.28)'
        }}
      >
        {/* Carrusel de fondo (1 imagen = solo Ken Burns). */}
        <HeroCarousel slides={slides} forceMobile={forceMobile} />
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            background: 'linear-gradient(to top, rgba(10, 15, 12, 0.92) 0%, rgba(10, 15, 12, 0.6) 45%, rgba(10, 15, 12, 0.42) 100%)'
          }}
        />
        {/* Orbs ambientales SOBRE la foto (blend screen, muy tenues): hacen
            "respirar" al hero aunque haya una imagen a pantalla completa. */}
        <div className="sala-orb" aria-hidden="true" style={{ width: 320, height: 320, top: '-12%', left: '-6%', zIndex: 2, opacity: 0.18, mixBlendMode: 'screen', animationDelay: '0s', '--orb-color': 'var(--sala-primary)' } as CSSProperties} />
        <div className="sala-orb" aria-hidden="true" style={{ width: 200, height: 200, bottom: '6%', right: '4%', zIndex: 2, opacity: 0.16, mixBlendMode: 'screen', animationDelay: '4s', '--orb-color': 'var(--sala-accent)' } as CSSProperties} />
        <div className="sala-orb" aria-hidden="true" style={{ width: 130, height: 130, top: '22%', right: '26%', zIndex: 2, opacity: 0.14, mixBlendMode: 'screen', animationDelay: '6s', '--orb-color': 'var(--sala-primary)' } as CSSProperties} />
        {/* Bloom dorado de profundidad detrás del título (warmth, como el hero de SALA). */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 3,
            pointerEvents: 'none',
            mixBlendMode: 'screen',
            opacity: 0.5,
            background: 'radial-gradient(48% 56% at 16% 86%, color-mix(in srgb, var(--sala-accent) 30%, transparent), transparent 62%)'
          }}
        />
        {/* Grain premium → textura film sobre la foto. */}
        <div className="sala-grain" aria-hidden="true" style={{ zIndex: 3 }} />
        {/* Glow ambiental que sigue el cursor (desktop). */}
        <div className="sala-spotlight" aria-hidden="true" />
        {/* En full-bleed la imagen ocupa todo el ancho, pero el texto se alinea
            con el contenido del resto de la página (maxWidth 1200, centrado). */}
        <div
          className="sala-fade-up"
          style={
            fullBleed
              ? { position: 'relative', zIndex: 4, width: '100%', maxWidth: '1200px', margin: '0 auto', padding: 'clamp(40px, 6vw, 72px) 24px' }
              : { position: 'relative', zIndex: 4 }
          }
        >
          {inner}
        </div>
      </div>
    </section>
  );
}

/**
 * Encabezado editable de una sección (eyebrow + título con acento + bajada).
 * Reemplaza los títulos que antes estaban hardcodeados en cada bloque. Cada
 * campo vacío se oculta; si todo está vacío, no renderiza nada.
 */
export function SeccionHeading({
  heading,
  center = true,
  editorial = false,
  light = false
}: {
  heading: LandingSeccionHeading;
  center?: boolean;
  /** Layout editorial: título a la izquierda + bajada a la derecha (apila en móvil). */
  editorial?: boolean;
  /** Sobre fondo oscuro: ajusta el color de la bajada. */
  light?: boolean;
}) {
  const { eyebrow, titulo, titulo_accent, subtitulo } = heading;
  if (!eyebrow && !titulo && !titulo_accent && !subtitulo) return null;

  const tituloBlock = (taLocal: 'left' | 'center') => (
    <>
      {eyebrow && (
        <p className="ek-eyebrow" style={{ marginBottom: '14px', textAlign: taLocal }}>
          {eyebrow}
        </p>
      )}
      {(titulo || titulo_accent) && (
        <h2
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(28px, 5vw, 60px)',
            fontWeight: 700,
            letterSpacing: '-0.04em',
            lineHeight: 1.02,
            margin: 0,
            textAlign: taLocal,
            color: light ? 'rgba(255, 255, 255, 0.98)' : 'var(--sala-text-primary)'
          }}
        >
          {titulo}
          {titulo_accent && (
            <>
              {titulo && <br />}
              <span
                style={{
                  // Acento del título en DORADO (acento del tenant), como la
                  // referencia. Sobre banda oscura, un toque más claro para
                  // contrastar; --ek-mustard (= primary) se perdía en lo oscuro.
                  color: light
                    ? 'color-mix(in srgb, var(--sala-accent), white 20%)'
                    : 'var(--sala-accent)'
                }}
              >
                {titulo_accent}
              </span>
            </>
          )}
        </h2>
      )}
    </>
  );

  // Editorial: dos columnas (título izq + bajada der). flexWrap → apila en móvil.
  if (editorial) {
    return (
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'clamp(16px, 4vw, 56px)',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginBottom: 'clamp(32px, 5vw, 56px)'
        }}
      >
        <div style={{ flex: '1 1 440px', minWidth: 0 }}>{tituloBlock('left')}</div>
        {subtitulo && (
          <p
            className={light ? undefined : 'ek-body-muted'}
            style={{
              flex: '1 1 280px',
              maxWidth: '460px',
              margin: 0,
              lineHeight: 1.6,
              ...(light ? { color: 'rgba(255, 255, 255, 0.7)' } : {})
            }}
          >
            {subtitulo}
          </p>
        )}
      </div>
    );
  }

  // Legacy: centrado o izquierda, bajada debajo.
  const ta = center ? 'center' : 'left';
  return (
    <div style={{ marginBottom: subtitulo ? 0 : 'clamp(32px, 5vw, 48px)' }}>
      {tituloBlock(ta)}
      {subtitulo && (
        <p
          className={light ? undefined : 'ek-body-muted'}
          style={{
            margin: center ? ' 16px auto clamp(32px, 5vw, 48px)' : '16px 0 clamp(32px, 5vw, 48px)',
            maxWidth: '600px',
            textAlign: ta,
            ...(light ? { color: 'rgba(255, 255, 255, 0.7)' } : {})
          }}
        >
          {subtitulo}
        </p>
      )}
    </div>
  );
}

export function SeccionPostHero({ data }: { data: LandingPostHero }) {
  if (data.variante === 'ninguna') return null;
  const items = data.items.filter((it) => it.titulo.trim() || it.texto.trim());
  if (!items.length) return null;

  // Encabezado compacto editorial (eyebrow + título con acento dorado), chico
  // y a la izquierda para no robar espacio.
  const header = (light: boolean) => (
    <div style={{ marginBottom: 'clamp(22px, 3vw, 34px)' }}>
      {data.eyebrow && (
        <p
          className={light ? undefined : 'ek-eyebrow'}
          style={
            light
              ? { fontSize: '11px', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'rgba(255, 255, 255, 0.55)', margin: '0 0 12px' }
              : { marginBottom: '12px' }
          }
        >
          {data.eyebrow}
        </p>
      )}
      {(data.titulo || data.titulo_accent) && (
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(26px, 4vw, 40px)',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          lineHeight: 1.05,
          margin: 0,
          maxWidth: '720px',
          color: light ? 'rgba(255, 255, 255, 0.97)' : 'var(--sala-text-primary)'
        }}>
          {data.titulo}
          {data.titulo_accent && (
            <>
              {data.titulo && ' '}
              <span style={{ color: light ? 'color-mix(in srgb, var(--sala-accent), white 20%)' : 'var(--sala-accent)' }}>
                {data.titulo_accent}
              </span>
            </>
          )}
        </h2>
      )}
    </div>
  );

  // Item compacto "tech": línea fina arriba + marca (número o ✓) + título + texto.
  const item = (marca: ReactNode, it: PostHeroItem, i: number, light: boolean) => (
    <div
      key={i}
      style={{
        borderTop: `1px solid ${light ? 'rgba(255, 255, 255, 0.16)' : 'var(--sala-border-strong)'}`,
        paddingTop: '16px'
      }}
    >
      <div style={{ marginBottom: '12px' }}>{marca}</div>
      <h3 style={{
        fontFamily: 'var(--ek-font-display)',
        fontSize: '17px',
        fontWeight: 600,
        letterSpacing: '-0.02em',
        margin: '0 0 5px',
        color: light ? 'rgba(255, 255, 255, 0.97)' : 'var(--sala-text-primary)'
      }}>
        {it.titulo}
      </h3>
      <p style={{
        fontSize: '14px',
        lineHeight: 1.5,
        margin: 0,
        color: light ? 'rgba(255, 255, 255, 0.6)' : 'var(--sala-text-secondary)'
      }}>
        {it.texto}
      </p>
    </div>
  );

  const grid = (children: ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 'clamp(20px, 3vw, 40px)' }}>
      {children}
    </div>
  );

  const numero = (i: number, light: boolean) => (
    <span style={{
      fontFamily: 'var(--ek-font-mono)',
      fontSize: '14px',
      fontWeight: 700,
      letterSpacing: '0.1em',
      color: light ? 'color-mix(in srgb, var(--sala-accent), white 20%)' : 'var(--sala-accent)'
    }}>
      {String(i + 1).padStart(2, '0')}
    </span>
  );

  // VARIANTE C — banda inmersiva de marca (destacados)
  if (data.variante === 'destacados') {
    return (
      <section style={{ padding: 'clamp(40px, 5vw, 72px) 0' }}>
        <div style={{
          background: 'var(--grad-immersive)',
          borderRadius: 'var(--ek-r-sm)',
          padding: 'clamp(28px, 4vw, 52px)',
          boxShadow: '0 24px 60px rgba(10, 15, 12, 0.28)'
        }}>
          {header(true)}
          {grid(items.map((it, i) => item(numero(i, true), it, i, true)))}
        </div>
      </section>
    );
  }

  // VARIANTE B — beneficios (check dorado)
  if (data.variante === 'beneficios') {
    return (
      <section style={{ padding: 'clamp(40px, 5vw, 72px) 0' }}>
        {header(false)}
        {grid(items.map((it, i) => item(
          <Check size={18} strokeWidth={2.5} style={{ color: 'var(--sala-accent)' }} />,
          it, i, false
        )))}
      </section>
    );
  }

  // VARIANTE A — pasos (numerados)
  return (
    <section style={{ padding: 'clamp(40px, 5vw, 72px) 0' }}>
      {header(false)}
      {grid(items.map((it, i) => item(numero(i, false), it, i, false)))}
    </section>
  );
}

/** Precio del tier en su moneda (Intl con código ISO en mayúsculas). Cae a un
 *  formato simple si la moneda no es válida. */
function formatearPrecioTier(centavos: number, moneda: string): string {
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: (moneda || 'MXN').toUpperCase(),
      maximumFractionDigits: 0
    }).format(centavos / 100);
  } catch {
    return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
  }
}

export default function Landing() {
  const [estudioAbierto, setEstudioAbierto] = useState<EstudioInfo | null>(null);
  const { estudios, isLoading: estudiosLoading } = useEstudiosPublicos();
  const { tiers, isLoading: tiersLoading } = useTiersPublicos();
  const { instructores } = useInstructoresPublicos();
  const { hero, secciones, post_hero, cta_final, faq, whatsappUrl, mostrarInstructores } = useLandingConfig();
  const ctaWhatsappUrl = whatsappUrl();

  // Nada hardcodeado: el rango de precios sale de los tiers reales (más caro /
  // más barato), no de los slugs 'pro'/'basica'. El plan "destacado" = el más caro.
  const precios = tiers.map((t) => t.precio_centavos);
  const precioPro = precios.length ? Math.max(...precios) : undefined;
  const precioBasica = precios.length ? Math.min(...precios) : undefined;
  const tierDestacadoSlug = tiers.length
    ? tiers.reduce((a, b) => (b.precio_centavos > a.precio_centavos ? b : a)).slug
    : null;

  const aEstudioInfo = (r: EstudioPublico): EstudioInfo => {
    // "Exclusiva" = la sala restringe a algún plan (cualquier slug).
    const esExclusivo = (r.tiers_permitidos?.length ?? 0) > 0;
    const tier: 'basica' | 'pro' = esExclusivo ? 'pro' : 'basica';
    return {
      slug: r.slug,
      nombre: r.nombre,
      tier,
      capacidad: r.capacidad_personas
        ? `Hasta ${r.capacidad_personas} personas`
        : 'Capacidad por confirmar',
      contenido: r.tipo_contenido ?? [],
      descripcion: r.descripcion ?? '',
      estiloVisual: r.estilo_visual ?? '',
      equipoIncluido: r.equipo_incluido ?? [],
      fotoUrl: r.foto_url ?? undefined,
      precioPro: precioPro ? Math.round(precioPro / 100) : undefined,
      precioBasica: precioBasica ? Math.round(precioBasica / 100) : undefined
    };
  };

  const estudiosInfo = estudios.map(aEstudioInfo);

  // Scroll reveal: cada sección .reveal aparece al entrar al viewport. Un solo
  // observer; respeta prefers-reduced-motion y cae a "todo visible" si no hay
  // IntersectionObserver. Re-corre cuando carga contenido (secciones async).
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>('.reveal:not(.visible)'));
    if (els.length === 0) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof IntersectionObserver === 'undefined') {
      els.forEach((el) => el.classList.add('visible'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('visible');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [estudiosLoading, tiersLoading, instructores.length, mostrarInstructores]);

  return (
    <div ref={rootRef} style={{
      maxWidth: '1200px',
      margin: '0 auto',
      padding: '0 24px'
    }}>
      {/* ============================================================
          HERO
          ============================================================ */}
      <HeroView hero={hero} />

      {/* ============================================================
          SECCIÓN POST-HERO (variante elegible desde admin)
          ============================================================ */}
      <div className="reveal"><SeccionPostHero data={post_hero} /></div>

      {/* ============================================================
          ESTUDIOS
          ============================================================ */}
      <section id="disciplinas" className="reveal" style={{ padding: 'clamp(56px, 8vw, 100px) 0' }}>
        <SeccionHeading heading={secciones.salas} editorial />

        {estudiosLoading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 440px), 1fr))', gap: 'clamp(16px, 2vw, 24px)' }}>
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="ek-skeleton" style={{ height: 'clamp(300px, 34vw, 380px)', borderRadius: 'var(--ek-r-sm)' }} />
            ))}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 440px), 1fr))', gap: 'clamp(16px, 2vw, 24px)' }}>
            {estudiosInfo.map((s) => (
              <button
                key={s.slug}
                onClick={() => setEstudioAbierto(s)}
                className="ek-lift"
                style={{
                  position: 'relative',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'flex-end',
                  minHeight: 'clamp(300px, 34vw, 380px)',
                  padding: 'clamp(22px, 3vw, 32px)',
                  overflow: 'hidden',
                  cursor: 'pointer',
                  textAlign: 'left',
                  font: 'inherit',
                  borderRadius: 'var(--ek-r-sm)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  background: s.fotoUrl ? '#0c100e' : 'var(--grad-immersive)',
                  color: '#fff',
                  boxShadow: '0 14px 36px rgba(10, 15, 12, 0.28)'
                }}
              >
                {s.fotoUrl ? (
                  <img
                    src={s.fotoUrl}
                    alt={s.nombre}
                    loading="lazy"
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <Dumbbell size={64} strokeWidth={1} style={{ position: 'absolute', top: '24px', right: '24px', color: 'rgba(255, 255, 255, 0.18)' }} />
                )}
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'linear-gradient(to top, rgba(10, 15, 12, 0.92) 0%, rgba(10, 15, 12, 0.5) 42%, rgba(10, 15, 12, 0.12) 100%)'
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    top: '18px',
                    left: '18px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '6px 12px',
                    borderRadius: '999px',
                    background: 'rgba(10, 15, 12, 0.5)',
                    backdropFilter: 'blur(6px)',
                    WebkitBackdropFilter: 'blur(6px)',
                    border: '1px solid rgba(255, 255, 255, 0.16)',
                    color: 'rgba(255, 255, 255, 0.92)',
                    fontSize: '10px',
                    fontWeight: 800,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase'
                  }}
                >
                  {s.tier === 'pro' ? <><Star size={11} strokeWidth={2.5} fill="currentColor" /> EXCLUSIVA</> : 'ABIERTA'}
                </span>
                <div style={{ position: 'relative', zIndex: 1 }}>
                  <h3 style={{
                    fontFamily: 'var(--ek-font-display)',
                    fontSize: 'clamp(30px, 4vw, 42px)',
                    fontWeight: 700,
                    letterSpacing: '-0.03em',
                    lineHeight: 1,
                    textTransform: 'uppercase',
                    margin: '0 0 10px',
                    color: '#fff'
                  }}>{s.nombre}</h3>
                  {s.descripcion && (
                    <p style={{
                      fontSize: '15px',
                      color: 'rgba(255, 255, 255, 0.82)',
                      margin: '0 0 20px',
                      maxWidth: '360px',
                      lineHeight: 1.45
                    }}>{s.descripcion}</p>
                  )}
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '7px',
                    padding: '10px 18px',
                    borderRadius: '999px',
                    background: 'rgba(255, 255, 255, 0.12)',
                    backdropFilter: 'blur(6px)',
                    WebkitBackdropFilter: 'blur(6px)',
                    border: '1px solid rgba(255, 255, 255, 0.22)',
                    color: '#fff',
                    fontSize: '13px',
                    fontWeight: 600
                  }}>
                    Ver más
                    <ArrowRight size={15} strokeWidth={2.25} />
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ============================================================
          INSTRUCTORES (S6-5 · toggle desde admin)
          ============================================================ */}
      {mostrarInstructores && instructores.length > 0 && (
        <section
          id="instructores"
          className="reveal"
          style={{
            width: '100vw',
            marginLeft: 'calc(50% - 50vw)',
            background: 'var(--grad-immersive)',
            padding: 'clamp(56px, 8vw, 100px) 0'
          }}
        >
          <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '0 24px' }}>
            <SeccionHeading heading={secciones.instructores} editorial light />

            <div className="landing-hscroll" style={{
              display: 'flex',
              gap: '14px',
              overflowX: 'auto',
              justifyContent: 'safe center',
              scrollSnapType: 'x mandatory',
              paddingBottom: '4px',
              marginInline: '-24px',
              paddingInline: '24px'
            }}>
              {instructores.map((i) => (
                <div key={i.id} className="landing-instructor-item">
                  <InstructorLandingCard instructor={i} />
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ============================================================
          MEMBRESÍAS
          ============================================================ */}
      <section id="membresias" className="reveal" style={{ padding: 'clamp(56px, 8vw, 100px) 0' }}>
        <SeccionHeading heading={secciones.membresias} editorial />

        {tiersLoading ? (
          <div className="landing-planes-grid">
            {[1, 2].map((n) => (
              <div key={n} className="ek-skeleton" style={{ height: '480px', borderRadius: 'var(--ek-r-sm)' }} />
            ))}
          </div>
        ) : (
          <div className="landing-planes-grid">
            {tiers.map((tier) => {
              const esDestacado = tier.slug === tierDestacadoSlug;
              const beneficios = parseBeneficios(tier.beneficios);

              return (
                <div
                  key={tier.slug}
                  className="ek-card landing-plan-card"
                  style={{
                    position: 'relative',
                    display: 'flex',
                    flexDirection: 'column',
                    borderRadius: 'var(--ek-r-sm)',
                    ...(esDestacado
                      ? {
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          background:
                            'var(--grad-immersive)',
                          boxShadow: '0 20px 44px var(--sala-primary-dim)',
                          transform: 'translateY(-4px)'
                        }
                      : {})
                  }}
                >
                  {esDestacado && (
                    <span
                      style={{
                        position: 'absolute',
                        top: '-13px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        background: 'var(--grad-accent)',
                        border: '1px solid var(--sala-accent)',
                        color: 'var(--sala-text-on-accent)',
                        fontSize: '10px',
                        fontWeight: 800,
                        letterSpacing: '0.12em',
                        textTransform: 'uppercase',
                        padding: '7px 16px',
                        borderRadius: '999px',
                        boxShadow: '0 6px 16px var(--sala-accent-dim)',
                        whiteSpace: 'nowrap',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px'
                      }}
                    >
                      <Star size={12} strokeWidth={2.5} fill="currentColor" />
                      Más elegido
                    </span>
                  )}
                  <p
                    style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      margin: '0 0 12px',
                      color: esDestacado ? 'rgba(255, 255, 255, 0.9)' : 'var(--sala-primary)'
                    }}
                  >
                    {tier.nombre.toUpperCase()}
                  </p>
                  <p style={{
                    fontFamily: 'var(--ek-font-display)',
                    fontSize: 'clamp(30px, 7vw, 48px)',
                    fontWeight: 700,
                    margin: 0,
                    letterSpacing: '-0.03em',
                    lineHeight: 1,
                    color: esDestacado ? 'rgba(255, 255, 255, 0.97)' : 'var(--sala-text-primary)'
                  }}>
                    {formatearPrecioTier(tier.precio_centavos, tier.moneda)}
                    <span style={{ fontSize: '16px', color: esDestacado ? 'rgba(255, 255, 255, 0.5)' : 'var(--sala-text-tertiary)', fontWeight: 500 }}>
                      {tier.periodo === 'anual' ? '/año' : '/mes'}
                    </span>
                  </p>
                  <p style={{
                    fontSize: '14px',
                    lineHeight: 1.5,
                    marginTop: '8px',
                    marginBottom: '24px',
                    color: esDestacado ? 'rgba(255, 255, 255, 0.62)' : 'var(--sala-text-secondary)'
                  }}>
                    {tier.descripcion ?? ''}
                  </p>
                  <ul
                    style={{
                      listStyle: 'none',
                      padding: 0,
                      margin: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px',
                      flex: 1
                    }}
                  >
                    {beneficios.map((b) => (
                      <li
                        key={b}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '8px',
                          fontSize: '14px',
                          color: esDestacado ? 'rgba(255, 255, 255, 0.85)' : 'var(--sala-text-primary)'
                        }}
                      >
                        <Check size={16} strokeWidth={2.5} style={{ color: esDestacado ? 'rgba(255, 255, 255, 0.9)' : 'var(--sala-primary)', flexShrink: 0, marginTop: '1px' }} />
                        {b}
                      </li>
                    ))}
                  </ul>
                  <Link
                    to={`/signup?tier=${tier.slug}`}
                    className={
                      esDestacado ? 'ek-cta ek-lift ek-cta--full' : 'ek-cta ek-cta--secondary ek-lift ek-cta--full'
                    }
                    style={{ marginTop: '28px' }}
                  >
                    {`Empezar con ${tier.nombre}`}
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ============================================================
          FAQ (editable desde el admin; oculta si el gym la dejó vacía)
          ============================================================ */}
      {faq.length > 0 && (
      <section className="reveal" style={{ padding: 'clamp(56px, 8vw, 100px) 0' }}>
        <SeccionHeading heading={secciones.faq} center={false} />

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {faq.map((item, i) => (
            <details
              key={`${item.pregunta}-${i}`}
              className="landing-faq-item"
              style={{ borderTop: '1px solid var(--sala-border-strong)', cursor: 'pointer' }}
            >
              <summary style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '17px',
                fontWeight: 600,
                letterSpacing: '-0.01em',
                listStyle: 'none',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '16px',
                padding: '20px 2px',
                color: 'var(--sala-text-primary)'
              }}>
                {item.pregunta}
                <span
                  className="landing-faq-plus"
                  aria-hidden="true"
                  style={{ color: 'var(--sala-accent)', fontSize: '22px', fontWeight: 400, lineHeight: 1, flexShrink: 0 }}
                >
                  +
                </span>
              </summary>
              <p style={{
                fontSize: '14px',
                color: 'var(--sala-text-secondary)',
                lineHeight: 1.6,
                margin: 0,
                padding: '0 2px 22px'
              }}>{item.respuesta}</p>
            </details>
          ))}
        </div>
      </section>
      )}

      {/* ============================================================
          CTA FINAL — slim y CONTENIDO. Ocultable: solo aparece si el
          tenant le puso un título (vacío = no se muestra).
          ============================================================ */}
      {cta_final.titulo && (
        <section className="reveal" style={{ padding: 'clamp(40px, 6vw, 80px) 0' }}>
          <div
            style={{
              background: 'var(--grad-immersive)',
              borderRadius: 'var(--ek-r-sm)',
              padding: 'clamp(28px, 4vw, 48px)',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'clamp(20px, 4vw, 40px)',
              boxShadow: '0 24px 60px rgba(10, 15, 12, 0.28)'
            }}
          >
            <div style={{ flex: '1 1 360px', minWidth: 0 }}>
              {cta_final.eyebrow && (
                <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'rgba(255, 255, 255, 0.55)', margin: '0 0 12px' }}>
                  {cta_final.eyebrow}
                </p>
              )}
              <h2 style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: 'clamp(26px, 4vw, 40px)',
                fontWeight: 700,
                letterSpacing: '-0.03em',
                lineHeight: 1.05,
                margin: 0,
                color: 'rgba(255, 255, 255, 0.98)'
              }}>
                {cta_final.titulo}
              </h2>
              {cta_final.subtitulo && (
                <p style={{ color: 'rgba(255, 255, 255, 0.7)', margin: '10px 0 0', maxWidth: '460px', lineHeight: 1.55 }}>
                  {cta_final.subtitulo}
                </p>
              )}
            </div>
            <a
              href={ctaWhatsappUrl || '#membresias'}
              {...(ctaWhatsappUrl ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="ek-cta ek-lift"
              style={{ padding: '16px 30px', fontSize: '15px', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
            >
              {cta_final.cta_texto || 'Ver membresías'}
            </a>
          </div>
        </section>
      )}

      {/* ============================================================
          FOOTER (extraído a src/public/components/Footer.tsx).
          Lleva id="contacto": el ancla del nav siempre cae acá (donde
          están email/dirección/redes), aunque el CTA final esté oculto.
          ============================================================ */}
      <div id="contacto"><Footer /></div>

      <EstudioModal
        estudio={estudioAbierto}
        onClose={() => setEstudioAbierto(null)}
      />
    </div>
  );
}
