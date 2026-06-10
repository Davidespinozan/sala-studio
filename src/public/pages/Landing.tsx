import { useEffect, useState } from 'react';
import { ArrowRight, Check, Dumbbell, Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { useLandingConfig, type LandingPostHero, type LandingHero } from '@shared/hooks/useLandingConfig';
import { useTenant } from '@shared/hooks/useTenant';
import EstudioModal, { type EstudioInfo } from '../components/EstudioModal';
import Footer from '../components/Footer';

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
        .select('slug, nombre, precio_centavos, descripcion, beneficios, reglas, orden')
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
        borderRadius: 'var(--ek-r-md)',
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
export function HeroView({ hero, preview = false }: { hero: LandingHero; preview?: boolean }) {
  const heroDesktop = hero.image_url || hero.image_url_mobile;
  const heroMobile = hero.image_url_mobile || hero.image_url;
  const hasImg = !!(hero.image_url || hero.image_url_mobile);
  const tituloColor = hasImg ? 'rgba(255, 255, 255, 0.98)' : 'var(--sala-text-primary)';
  const subColor = hasImg ? 'rgba(255, 255, 255, 0.88)' : 'var(--ek-ink-muted)';
  // Sobre imagen, el acento va en un tono CLARO de la marca (el primary
  // oscuro era casi ilegible sobre la foto).
  const accentColor = hasImg ? 'color-mix(in srgb, var(--sala-primary), white 62%)' : 'var(--ek-mustard)';

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
      <a
        href={hero.cta_link || '#membresias'}
        className="ek-cta ek-lift"
        style={{ padding: hasImg ? '17px 34px' : '16px 28px', fontSize: '16px', display: 'inline-flex', alignItems: 'center' }}
      >
        {hero.cta_texto}
      </a>
    </>
  );

  // Estilo del hero con imagen, elegible desde admin:
  //   'completo'  → full-bleed de borde a borde (rompe el contenedor 1200)
  //   'contenido' → card con esquinas redondeadas flotando sobre el fondo
  const fullBleed = hero.layout === 'completo';

  if (!hasImg) {
    return (
      <section style={{
        minHeight: preview ? '420px' : '90vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        position: 'relative',
        padding: '40px 0'
      }}>
        <div style={{
          position: 'absolute',
          top: '20%',
          right: '-200px',
          width: '500px',
          height: '500px',
          background: 'radial-gradient(circle, var(--sala-primary-soft), transparent 70%)',
          borderRadius: '50%',
          pointerEvents: 'none'
        }} />
        {inner}
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
      <div className="landing-hero-card" style={{
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
      }}>
        <picture>
          <source media="(max-width: 640px)" srcSet={heroMobile} />
          <img
            src={heroDesktop}
            alt=""
            aria-hidden="true"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </picture>
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(to top, rgba(10, 15, 12, 0.92) 0%, rgba(10, 15, 12, 0.6) 45%, rgba(10, 15, 12, 0.42) 100%)'
          }}
        />
        {/* En full-bleed la imagen ocupa todo el ancho, pero el texto se alinea
            con el contenido del resto de la página (maxWidth 1200, centrado). */}
        <div
          style={
            fullBleed
              ? { position: 'relative', width: '100%', maxWidth: '1200px', margin: '0 auto', padding: 'clamp(40px, 6vw, 72px) 24px' }
              : { position: 'relative' }
          }
        >
          {inner}
        </div>
      </div>
    </section>
  );
}

export function SeccionPostHero({ data }: { data: LandingPostHero }) {
  if (data.variante === 'ninguna') return null;
  const items = data.items.filter((it) => it.titulo.trim() || it.texto.trim());
  if (!items.length) return null;

  const tituloH2 = (light: boolean) =>
    (data.titulo || data.titulo_accent) && (
      <h2 style={{
        fontFamily: 'var(--ek-font-display)',
        fontSize: 'clamp(32px, 6vw, 52px)',
        fontWeight: 700,
        letterSpacing: '-0.04em',
        lineHeight: 1.05,
        margin: 0,
        marginBottom: '40px',
        color: light ? 'rgba(255, 255, 255, 0.97)' : 'var(--sala-text-primary)'
      }}>
        {data.titulo}
        {data.titulo_accent && (
          <>
            {data.titulo && <br />}
            <span style={{ color: light ? 'rgba(255, 255, 255, 0.7)' : 'var(--ek-mustard)' }}>
              {data.titulo_accent}
            </span>
          </>
        )}
      </h2>
    );

  // VARIANTE C — banda inmersiva de marca (destacados)
  if (data.variante === 'destacados') {
    return (
      <section style={{ padding: 'clamp(36px, 6vw, 64px) 0' }}>
        <div style={{
          background: 'var(--grad-immersive)',
          borderRadius: 'var(--ek-r-card)',
          padding: 'clamp(36px, 5vw, 64px)',
          boxShadow: '0 24px 60px rgba(10, 15, 12, 0.28)'
        }}>
          {data.eyebrow && (
            <p style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'rgba(255, 255, 255, 0.55)', margin: '0 0 12px' }}>
              {data.eyebrow}
            </p>
          )}
          {tituloH2(true)}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '28px' }}>
            {items.map((it, i) => (
              <div key={i}>
                <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '22px', fontWeight: 700, letterSpacing: '-0.02em', margin: 0, color: 'rgba(255, 255, 255, 0.97)' }}>
                  {it.titulo}
                </p>
                <p style={{ fontSize: '14px', lineHeight: 1.5, margin: '8px 0 0', color: 'rgba(255, 255, 255, 0.6)' }}>
                  {it.texto}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  // VARIANTE B — beneficios (icono en círculo tintado)
  if (data.variante === 'beneficios') {
    return (
      <section style={{ padding: 'clamp(36px, 6vw, 64px) 0' }}>
        {data.eyebrow && <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>{data.eyebrow}</p>}
        {tituloH2(false)}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '20px' }}>
          {items.map((it, i) => (
            <div key={i} className="ek-card">
              <div aria-hidden="true" style={{ width: '44px', height: '44px', borderRadius: '12px', background: 'var(--sala-primary-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '14px' }}>
                <Check size={22} strokeWidth={2.5} style={{ color: 'var(--sala-primary)' }} />
              </div>
              <h3 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '20px', fontWeight: 600, letterSpacing: '-0.02em', margin: '0 0 6px', color: 'var(--sala-text-primary)' }}>
                {it.titulo}
              </h3>
              <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', lineHeight: 1.5, margin: 0 }}>
                {it.texto}
              </p>
            </div>
          ))}
        </div>
      </section>
    );
  }

  // VARIANTE A — pasos (numerados)
  return (
    <section style={{ padding: 'clamp(36px, 6vw, 64px) 0' }}>
      {data.eyebrow && <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>{data.eyebrow}</p>}
      {tituloH2(false)}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '20px' }}>
        {items.map((it, i) => (
          <div key={i} className="ek-card">
            <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '34px', fontWeight: 700, color: 'var(--sala-accent)', margin: '0 0 12px', letterSpacing: '-0.04em' }}>
              {String(i + 1).padStart(2, '0')}
            </p>
            <h3 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '20px', fontWeight: 600, letterSpacing: '-0.02em', margin: '0 0 8px', color: 'var(--sala-text-primary)' }}>
              {it.titulo}
            </h3>
            <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', lineHeight: 1.5, margin: 0 }}>
              {it.texto}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatearPesos(centavos: number): string {
  return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
}

export default function Landing() {
  const [estudioAbierto, setEstudioAbierto] = useState<EstudioInfo | null>(null);
  const { estudios, isLoading: estudiosLoading } = useEstudiosPublicos();
  const { tiers, isLoading: tiersLoading } = useTiersPublicos();
  const { instructores } = useInstructoresPublicos();
  const { hero, post_hero, cta_final, whatsappUrl, mostrarInstructores } = useLandingConfig();
  const ctaWhatsappUrl = whatsappUrl();

  const precioPro = tiers.find((t) => t.slug === 'pro')?.precio_centavos;
  const precioBasica = tiers.find((t) => t.slug === 'basica')?.precio_centavos;

  const aEstudioInfo = (r: EstudioPublico): EstudioInfo => {
    const esPro = r.tiers_permitidos.length === 1 && r.tiers_permitidos[0] === 'pro';
    const tier: 'basica' | 'pro' = esPro ? 'pro' : 'basica';
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
  // Con 3+ salas, carrusel horizontal (en vez de apilar filas en desktop).
  const salasScroll = estudiosInfo.length >= 3;

  return (
    <div style={{
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
      <SeccionPostHero data={post_hero} />

      {/* ============================================================
          ESTUDIOS
          ============================================================ */}
      <section style={{ padding: 'clamp(36px, 6vw, 64px) 0' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>NUESTRAS SALAS</p>
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          lineHeight: 1.05,
          margin: 0,
          marginBottom: '16px'
        }}>
          Varias disciplinas.<br />
          <span style={{ color: 'var(--ek-mustard)' }}>Un solo lugar.</span>
        </h2>
        <p className="ek-body-muted" style={{ marginBottom: '40px', maxWidth: '600px' }}>
          Cada sala diseñada para una disciplina distinta. Elegí la que va con vos.
        </p>

        {estudiosLoading ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '20px'
          }}>
            {[1, 2, 3].map((n) => (
              <div key={n} className="ek-skeleton" style={{ height: '380px', borderRadius: 'var(--ek-r-card)' }} />
            ))}
          </div>
        ) : (
          <div
            style={
              salasScroll
                ? {
                    display: 'flex',
                    gap: '20px',
                    overflowX: 'auto',
                    scrollSnapType: 'x mandatory',
                    paddingBottom: '12px',
                    marginInline: '-24px',
                    paddingInline: '24px',
                    scrollbarWidth: 'thin'
                  }
                : {
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                    gap: '20px'
                  }
            }
          >
            {estudiosInfo.map((s) => (
              <button
                key={s.slug}
                onClick={() => setEstudioAbierto(s)}
                className="ek-card"
                style={{
                  padding: 0,
                  overflow: 'hidden',
                  cursor: 'pointer',
                  textAlign: 'left',
                  borderRadius: 'var(--ek-r-card)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  background: 'var(--grad-immersive)',
                  color: 'rgba(255, 255, 255, 0.96)',
                  boxShadow: '0 10px 28px rgba(10, 15, 12, 0.22)',
                  transition: 'transform 0.2s ease, filter 0.2s ease',
                  font: 'inherit',
                  ...(salasScroll
                    ? { flex: '0 0 clamp(280px, 80vw, 340px)', scrollSnapAlign: 'start' }
                    : {})
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.filter = 'brightness(1.08)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.filter = 'brightness(1)';
                }}
              >
                <div style={{
                  aspectRatio: '16 / 10',
                  position: 'relative',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: s.fotoUrl ? 'transparent' : 'rgba(255, 255, 255, 0.04)'
                }}>
                  {s.fotoUrl ? (
                    <img
                      src={s.fotoUrl}
                      alt={s.nombre}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  ) : (
                    <Dumbbell size={48} strokeWidth={1.25} style={{ color: 'rgba(255, 255, 255, 0.9)', opacity: 0.6 }} />
                  )}
                  <div
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      background: 'linear-gradient(to top, rgba(10, 15, 12, 0.55) 0%, transparent 55%)',
                      pointerEvents: 'none'
                    }}
                  />
                  <span
                    style={{
                      position: 'absolute',
                      top: '14px',
                      left: '14px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '5px 11px',
                      borderRadius: '999px',
                      background: 'rgba(10, 15, 12, 0.55)',
                      backdropFilter: 'blur(6px)',
                      WebkitBackdropFilter: 'blur(6px)',
                      border: '1px solid rgba(255, 255, 255, 0.14)',
                      color: s.tier === 'pro' ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.9)',
                      fontSize: '10px',
                      fontWeight: 800,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase'
                    }}
                  >
                    {s.tier === 'pro' ? <><Star size={11} strokeWidth={2.5} fill="currentColor" /> PRO</> : 'BÁSICA'}
                  </span>
                </div>
                <div style={{ padding: '20px' }}>
                  <h3 style={{
                    fontFamily: 'var(--ek-font-display)',
                    fontSize: '24px',
                    fontWeight: 700,
                    margin: 0,
                    marginBottom: '6px',
                    color: 'rgba(255, 255, 255, 0.96)'
                  }}>{s.nombre}</h3>
                  <p style={{
                    fontSize: '13px',
                    color: 'rgba(255, 255, 255, 0.6)',
                    margin: 0,
                    marginBottom: '6px'
                  }}>{s.capacidad}</p>
                  <p style={{
                    fontSize: '12px',
                    color: 'rgba(255, 255, 255, 0.9)',
                    margin: 0,
                    marginBottom: '12px',
                    fontWeight: 600
                  }}>{s.contenido.join(' · ')}</p>
                  <p style={{
                    fontSize: '11px',
                    color: 'rgba(255, 255, 255, 0.9)',
                    margin: 0,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}>
                    Ver detalle
                    <ArrowRight size={12} strokeWidth={2.5} />
                  </p>
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
        <section style={{ padding: 'clamp(36px, 6vw, 64px) 0' }}>
          <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>NUESTRO EQUIPO</p>
          <h2 style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(36px, 6vw, 56px)',
            fontWeight: 700,
            letterSpacing: '-0.04em',
            lineHeight: 1.05,
            margin: 0,
            marginBottom: '16px'
          }}>
            Conocé a nuestros<br />
            <span style={{ color: 'var(--ek-mustard)' }}>instructores.</span>
          </h2>
          <p className="ek-body-muted" style={{ marginBottom: '40px', maxWidth: '600px' }}>
            El equipo que te va a acompañar en cada clase.
          </p>

          <div style={{
            display: 'flex',
            gap: '14px',
            overflowX: 'auto',
            scrollSnapType: 'x mandatory',
            paddingBottom: '12px',
            marginInline: '-24px',
            paddingInline: '24px',
            scrollbarWidth: 'thin'
          }}>
            {instructores.map((i) => (
              <div key={i.id} style={{ flex: '0 0 160px', scrollSnapAlign: 'start' }}>
                <InstructorLandingCard instructor={i} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ============================================================
          MEMBRESÍAS
          ============================================================ */}
      <section id="membresias" style={{ padding: 'clamp(36px, 6vw, 64px) 0' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>MEMBRESÍAS</p>
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          lineHeight: 1.05,
          margin: 0,
          marginBottom: '48px'
        }}>
          Elige tu nivel.<br />
          <span style={{ color: 'var(--ek-mustard)' }}>Crece desde el día uno.</span>
        </h2>

        {tiersLoading ? (
          <div className="landing-planes-grid">
            {[1, 2].map((n) => (
              <div key={n} className="ek-skeleton" style={{ height: '480px', borderRadius: 'var(--ek-r-card)' }} />
            ))}
          </div>
        ) : (
          <div className="landing-planes-grid">
            {tiers.map((tier) => {
              const esPro = tier.slug === 'pro';
              const beneficios = parseBeneficios(tier.beneficios);

              return (
                <div
                  key={tier.slug}
                  className="ek-card"
                  style={{
                    padding: '32px',
                    position: 'relative',
                    display: 'flex',
                    flexDirection: 'column',
                    ...(esPro
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
                  {esPro && (
                    <span
                      style={{
                        position: 'absolute',
                        top: '-12px',
                        left: '32px',
                        background: 'rgba(10, 15, 12, 0.92)',
                        border: '1px solid rgba(255, 255, 255, 0.16)',
                        color: 'rgba(255, 255, 255, 0.9)',
                        fontSize: '10px',
                        fontWeight: 800,
                        letterSpacing: '0.12em',
                        textTransform: 'uppercase',
                        padding: '6px 14px',
                        borderRadius: '999px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px'
                      }}
                    >
                      <Star size={12} strokeWidth={2.5} fill="currentColor" />
                      Recomendada
                    </span>
                  )}
                  <p
                    style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      margin: '0 0 12px',
                      color: esPro ? 'rgba(255, 255, 255, 0.9)' : 'var(--sala-primary)'
                    }}
                  >
                    {esPro ? 'PLAN PRO' : tier.nombre.toUpperCase()}
                  </p>
                  <p style={{
                    fontFamily: 'var(--ek-font-display)',
                    fontSize: '48px',
                    fontWeight: 700,
                    margin: 0,
                    letterSpacing: '-0.03em',
                    lineHeight: 1,
                    color: esPro ? 'rgba(255, 255, 255, 0.97)' : 'var(--sala-text-primary)'
                  }}>
                    {formatearPesos(tier.precio_centavos)}
                    <span style={{ fontSize: '16px', color: esPro ? 'rgba(255, 255, 255, 0.5)' : 'var(--sala-text-tertiary)', fontWeight: 500 }}>
                      /mes
                    </span>
                  </p>
                  <p style={{
                    fontSize: '14px',
                    lineHeight: 1.5,
                    marginTop: '8px',
                    marginBottom: '24px',
                    color: esPro ? 'rgba(255, 255, 255, 0.62)' : 'var(--sala-text-secondary)'
                  }}>
                    {tier.descripcion ??
                      (esPro
                        ? 'Para los que entrenan en serio. Acceso completo.'
                        : 'Para arrancar. Acceso a las salas básicas.')}
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
                          color: esPro ? 'rgba(255, 255, 255, 0.85)' : 'var(--sala-text-primary)'
                        }}
                      >
                        <Check size={16} strokeWidth={2.5} style={{ color: esPro ? 'rgba(255, 255, 255, 0.9)' : 'var(--sala-primary)', flexShrink: 0, marginTop: '1px' }} />
                        {b}
                      </li>
                    ))}
                  </ul>
                  <Link
                    to={`/signup?tier=${tier.slug}`}
                    className={
                      esPro ? 'ek-cta ek-lift ek-cta--full' : 'ek-cta ek-cta--secondary ek-lift ek-cta--full'
                    }
                    style={{ marginTop: '28px' }}
                  >
                    {esPro ? 'Quiero la Pro' : `Empezar con ${tier.nombre}`}
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ============================================================
          FAQ
          ============================================================ */}
      <section style={{ padding: 'clamp(36px, 6vw, 64px) 0' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>PREGUNTAS FRECUENTES</p>
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          lineHeight: 1.05,
          margin: 0,
          marginBottom: '48px'
        }}>
          Lo que probablemente querés saber.
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {[
            {
              q: '¿Qué incluye la membresía?',
              a: 'Acceso a las salas según tu plan, todo el equipo ya montado (colchonetas, mancuernas, bicicletas, lo que aplique según la disciplina), posibilidad de traer invitados y reservas vía app.'
            },
            {
              q: '¿Puedo cancelar cuando quiera?',
              a: 'El compromiso mínimo es de 6 meses. Después podés cancelar con 30 días de anticipación. Sin penalidades pasado el commitment.'
            },
            {
              q: '¿Qué pasa si no llego a mi clase?',
              a: 'Las inasistencias bloquean tu cuenta por 1 semana automáticamente. Pero si avisás con anticipación, podés cancelar sin penalidad.'
            },
            {
              q: '¿Necesito traer mi propio equipo?',
              a: 'No. Cada sala tiene lo necesario para su disciplina. Solo traés ropa cómoda y una botella de agua.'
            },
            {
              q: '¿Puedo invitar gente?',
              a: 'Sí. Básica permite hasta 2 invitados por clase, Pro hasta 4. Para grupos más grandes, contactanos.'
            },
            {
              q: '¿Cómo me cobran?',
              a: 'Cobro mensual automatizado vía tarjeta. El primer mes incluye onboarding y configuración de tu cuenta.'
            }
          ].map((item) => (
            <details key={item.q} className="ek-card" style={{ padding: '20px 24px', cursor: 'pointer' }}>
              <summary style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '17px',
                fontWeight: 600,
                letterSpacing: '-0.01em',
                listStyle: 'none',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                {item.q}
                <span style={{ color: 'var(--ek-mustard)', fontSize: '14px' }}>+</span>
              </summary>
              <p style={{
                fontSize: '14px',
                color: 'var(--ek-ink-muted)',
                lineHeight: 1.6,
                margin: 0,
                marginTop: '12px'
              }}>{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ============================================================
          CTA + CONTACTO
          ============================================================ */}
      <section id="contacto" style={{ padding: '100px 0' }}>
        <div style={{
          background: 'linear-gradient(135deg, var(--ek-bg-elevated) 0%, var(--ek-bg) 100%)',
          border: '0.5px solid var(--ek-mustard-dim)',
          borderRadius: 'var(--ek-r-card)',
          padding: 'clamp(32px, 6vw, 64px)',
          textAlign: 'center',
          position: 'relative',
          overflow: 'hidden'
        }}>
          <div style={{
            position: 'absolute',
            top: '-100px',
            right: '-100px',
            width: '300px',
            height: '300px',
            background: 'radial-gradient(circle, var(--sala-primary-soft), transparent 70%)',
            borderRadius: '50%',
            pointerEvents: 'none'
          }} />

          {cta_final.eyebrow && (
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '16px' }}>
              {cta_final.eyebrow}
            </p>
          )}
          <h2 style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(32px, 5vw, 48px)',
            fontWeight: 700,
            letterSpacing: '-0.04em',
            margin: 0,
            marginBottom: '16px',
            lineHeight: 1.1
          }}>
            {cta_final.titulo}
          </h2>
          {cta_final.subtitulo && (
            <p className="ek-body-muted" style={{ marginBottom: '32px', maxWidth: '500px', marginLeft: 'auto', marginRight: 'auto' }}>
              {cta_final.subtitulo}
            </p>
          )}
          {ctaWhatsappUrl ? (
            <a
              href={ctaWhatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ek-cta"
              style={{ padding: '18px 32px', fontSize: '15px' }}
            >
              {cta_final.cta_texto}
            </a>
          ) : (
            <span
              style={{
                fontSize: '12px',
                color: 'var(--ek-ink-faint)',
                fontStyle: 'italic'
              }}
              title="Configura el WhatsApp en /admin/configuracion"
            >
              (Contacto sin configurar)
            </span>
          )}
        </div>
      </section>

      {/* ============================================================
          FOOTER (extraído a src/public/components/Footer.tsx)
          ============================================================ */}
      <Footer />

      <EstudioModal
        estudio={estudioAbierto}
        onClose={() => setEstudioAbierto(null)}
      />
    </div>
  );
}
