import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useTenantConfigEditor } from '../hooks/useTenantConfigEditor';
import { useToast } from '@shared/hooks/useToast';
import { useTenant } from '@shared/hooks/useTenant';
import Toggle from '../components/Toggle';
import ImageUploader from '../components/ImageUploader';
import LandingPreview from '../components/LandingPreview';
import {
  SECCIONES_DEFAULT,
  type LandingSecciones,
  type LandingSeccionHeading
} from '@shared/hooks/useLandingConfig';

type HeroLayout = 'contenido' | 'completo';

/** Lee los slides del hero desde config. Migra la imagen única vieja
 *  (image_url/image_url_mobile) a un slide 1 si todavía no hay carrusel. */
function readHeroSlides(hero: Record<string, unknown>): { desktop: string; mobile: string }[] {
  const raw = hero.imagenes;
  let slides: { desktop: string; mobile: string }[] = [];
  if (Array.isArray(raw)) {
    slides = raw
      .map((it) => {
        if (typeof it === 'string') return { desktop: it.trim(), mobile: '' };
        if (it && typeof it === 'object') {
          const o = it as Record<string, unknown>;
          return { desktop: String(o.desktop ?? '').trim(), mobile: String(o.mobile ?? '').trim() };
        }
        return { desktop: '', mobile: '' };
      })
      .filter((s) => s.desktop.length > 0);
  }
  if (slides.length === 0) {
    const d = String(hero.image_url ?? '').trim();
    const m = String(hero.image_url_mobile ?? '').trim();
    if (d || m) slides = [{ desktop: d || m, mobile: m }];
  }
  return slides;
}

/** Botón chico (✕/←/→) sobre las miniaturas del carrusel del hero. */
const miniBtn: CSSProperties = {
  width: '22px',
  height: '22px',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '6px',
  border: 'none',
  cursor: 'pointer',
  background: 'rgba(0,0,0,0.6)',
  color: '#fff',
  fontSize: '12px',
  lineHeight: 1
};
type HeroDraft = {
  eyebrow: string;
  titulo: string;
  titulo_accent: string;
  subtitulo: string;
  cta_texto: string;
  cta2_texto: string;
  cta2_link: string;
  image_url: string;
  image_url_mobile: string;
  imagenes: { desktop: string; mobile: string }[];
  layout: HeroLayout;
};

const HERO_LAYOUT_OPTS: { value: HeroLayout; label: string; hint: string }[] = [
  { value: 'contenido', label: 'Contenido', hint: 'Card con esquinas redondeadas, flota sobre el fondo' },
  { value: 'completo', label: 'Completo', hint: 'Imagen full-bleed, de borde a borde' }
];

type CtaFinalDraft = {
  eyebrow: string;
  titulo: string;
  subtitulo: string;
  cta_texto: string;
};

type FooterDraft = {
  tagline: string;
  copyright: string;
  direccion: string;
  email: string;
};

type PostHeroVar = 'pasos' | 'beneficios' | 'destacados' | 'ninguna';
type PostHeroDraft = {
  variante: PostHeroVar;
  eyebrow: string;
  titulo: string;
  titulo_accent: string;
  items: { titulo: string; texto: string }[];
};

const POST_HERO_VAR_OPTS: { value: PostHeroVar; label: string }[] = [
  { value: 'pasos', label: 'Pasos' },
  { value: 'beneficios', label: 'Beneficios' },
  { value: 'destacados', label: 'Destacados' },
  { value: 'ninguna', label: 'Ocultar' }
];

const POST_HERO_DEFAULT: PostHeroDraft = {
  variante: 'pasos',
  eyebrow: 'CÓMO FUNCIONA',
  titulo: 'De cero a tu primera clase.',
  titulo_accent: 'En tres pasos.',
  items: [
    { titulo: 'Elige tu plan', texto: 'Elige la membresía que va con tu ritmo. Sin permanencia rara, sin letra chica.' },
    { titulo: 'Reserva desde la app', texto: 'Elige sala, día y horario en segundos. Sin llamadas, sin esperar.' },
    { titulo: 'Llega y entrena', texto: 'Muestra tu QR en recepción y listo. Las salas ya están montadas con todo el equipo.' }
  ]
};

type FaqDraftItem = { pregunta: string; respuesta: string };

type LandingDraft = {
  hero: HeroDraft;
  secciones: LandingSecciones;
  post_hero: PostHeroDraft;
  cta_final: CtaFinalDraft;
  footer: FooterDraft;
  faq: FaqDraftItem[];
  mostrar_instructores: boolean;
};

/** Heading nunca guardado → default; guardado (aunque con campos vacíos) → se
 *  respeta (vacío = ocultar ese campo en la landing). */
function readSecciones(landing: Record<string, unknown>): LandingSecciones {
  const o = (landing.secciones && typeof landing.secciones === 'object'
    ? landing.secciones
    : {}) as Record<string, unknown>;
  const one = (v: unknown, def: LandingSeccionHeading): LandingSeccionHeading => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return def;
    const r = v as Record<string, unknown>;
    return {
      eyebrow: String(r.eyebrow ?? ''),
      titulo: String(r.titulo ?? ''),
      titulo_accent: String(r.titulo_accent ?? ''),
      subtitulo: String(r.subtitulo ?? '')
    };
  };
  return {
    salas: one(o.salas, SECCIONES_DEFAULT.salas),
    membresias: one(o.membresias, SECCIONES_DEFAULT.membresias),
    instructores: one(o.instructores, SECCIONES_DEFAULT.instructores),
    faq: one(o.faq, SECCIONES_DEFAULT.faq)
  };
}

// FAQ genérico de arranque (sin reglas falsas). El admin lo edita a su realidad.
const FAQ_STARTER: FaqDraftItem[] = [
  { pregunta: '¿Qué incluye la membresía?', respuesta: 'Acceso a las salas y clases según tu plan, con reservas desde la app.' },
  { pregunta: '¿Cómo reservo una clase?', respuesta: 'Desde la app: eliges sala, día y horario, y muestras tu QR al llegar.' },
  { pregunta: '¿Puedo cancelar una reserva?', respuesta: 'Sí. Cancela con anticipación para liberar tu lugar.' }
];

const EMPTY: LandingDraft = {
  hero: { eyebrow: '', titulo: '', titulo_accent: '', subtitulo: '', cta_texto: '', cta2_texto: '', cta2_link: '#membresias', image_url: '', image_url_mobile: '', imagenes: [], layout: 'contenido' },
  secciones: SECCIONES_DEFAULT,
  post_hero: POST_HERO_DEFAULT,
  cta_final: { eyebrow: '', titulo: '', subtitulo: '', cta_texto: '' },
  footer: { tagline: '', copyright: '', direccion: '', email: '' },
  faq: [],
  mostrar_instructores: false
};

function readLanding(config: Record<string, unknown> | null): LandingDraft {
  const landing = (config?.landing ?? {}) as Record<string, unknown>;
  const hero = (landing.hero ?? {}) as Record<string, unknown>;
  const ctaFinal = (landing.cta_final ?? {}) as Record<string, unknown>;
  const footer = (landing.footer ?? {}) as Record<string, unknown>;

  // post_hero: si no hay nada guardado, mostrar el default editable.
  let post_hero: PostHeroDraft;
  if (!landing.post_hero || typeof landing.post_hero !== 'object') {
    post_hero = POST_HERO_DEFAULT;
  } else {
    const ph = landing.post_hero as Record<string, unknown>;
    const phItems = Array.isArray(ph.items) ? ph.items : [];
    const items = [0, 1, 2].map((i) => {
      const o = (phItems[i] ?? {}) as Record<string, unknown>;
      return { titulo: String(o.titulo ?? ''), texto: String(o.texto ?? '') };
    });
    const variante = POST_HERO_VAR_OPTS.some((v) => v.value === ph.variante)
      ? (ph.variante as PostHeroVar)
      : 'pasos';
    post_hero = {
      variante,
      eyebrow: String(ph.eyebrow ?? ''),
      titulo: String(ph.titulo ?? ''),
      titulo_accent: String(ph.titulo_accent ?? ''),
      items
    };
  }

  return {
    hero: {
      eyebrow: String(hero.eyebrow ?? ''),
      titulo: String(hero.titulo ?? ''),
      titulo_accent: String(hero.titulo_accent ?? ''),
      subtitulo: String(hero.subtitulo ?? ''),
      cta_texto: String(hero.cta_texto ?? ''),
      cta2_texto: String(hero.cta2_texto ?? ''),
      cta2_link: String(hero.cta2_link ?? '#membresias'),
      image_url: String(hero.image_url ?? ''),
      image_url_mobile: String(hero.image_url_mobile ?? ''),
      imagenes: readHeroSlides(hero),
      layout: hero.layout === 'completo' ? 'completo' : 'contenido'
    },
    cta_final: {
      eyebrow: String(ctaFinal.eyebrow ?? ''),
      titulo: String(ctaFinal.titulo ?? ''),
      subtitulo: String(ctaFinal.subtitulo ?? ''),
      cta_texto: String(ctaFinal.cta_texto ?? '')
    },
    footer: {
      tagline: String(footer.tagline ?? ''),
      copyright: String(footer.copyright ?? ''),
      direccion: footer.direccion == null ? '' : String(footer.direccion),
      email: footer.email == null ? '' : String(footer.email)
    },
    post_hero,
    secciones: readSecciones(landing),
    faq: readFaq(landing.faq),
    mostrar_instructores: landing.mostrar_instructores === true
  };
}

/** FAQ guardado, o el starter genérico si el gym nunca lo tocó. */
function readFaq(value: unknown): FaqDraftItem[] {
  if (!Array.isArray(value)) return FAQ_STARTER;
  const items = (value as unknown[]).map((it) => {
    const o = (it ?? {}) as Record<string, unknown>;
    return { pregunta: String(o.pregunta ?? ''), respuesta: String(o.respuesta ?? '') };
  });
  // Array guardado (aunque vacío) se respeta: vacío = el gym ocultó el FAQ.
  return items;
}

function PageHeader({
  title,
  subtitle,
  dirty
}: {
  title: string;
  subtitle: string;
  dirty: boolean;
}) {
  return (
    <div style={{ marginBottom: '24px' }}>
      <p className="ek-eyebrow">AJUSTES</p>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: '16px',
          flexWrap: 'wrap',
          marginTop: '4px'
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: 'clamp(28px, 5vw, 40px)',
              fontWeight: 700,
              letterSpacing: '-0.04em',
              margin: 0,
              marginBottom: '6px'
            }}
          >
            {title}
          </h1>
          <p style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', margin: 0 }}>{subtitle}</p>
        </div>
        <span
          style={{
            fontSize: '11px',
            color: dirty ? 'var(--ek-mustard)' : 'var(--ek-ink-faint)',
            fontWeight: 600,
            letterSpacing: '0.08em'
          }}
        >
          {dirty ? 'CAMBIOS SIN GUARDAR' : 'SIN CAMBIOS'}
        </span>
      </div>
    </div>
  );
}

function FormField({
  label,
  helper,
  count,
  max,
  children
}: {
  label: string;
  helper?: string;
  /** Si se pasan count+max, muestra un contador "X/N" (ámbar si se pasa). */
  count?: number;
  max?: number;
  children: React.ReactNode;
}) {
  const showCount = count != null && max != null;
  const over = showCount && count > max;
  return (
    <div className="ek-form-field" style={{ marginBottom: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
        <label className="ek-label">{label}</label>
        {showCount && (
          <span
            style={{
              fontSize: '11px',
              fontVariantNumeric: 'tabular-nums',
              color: over ? 'var(--sala-warning)' : 'var(--ek-ink-faint)'
            }}
          >
            {count}/{max}
          </span>
        )}
      </div>
      {children}
      {helper && (
        <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>{helper}</p>
      )}
    </div>
  );
}

/** 4 inputs (eyebrow + título + acento + bajada) para el encabezado de una
 *  sección de la landing. Cada campo vacío se oculta en la página pública. */
function SeccionHeadingFields({
  value,
  onChange
}: {
  value: LandingSeccionHeading;
  onChange: (v: LandingSeccionHeading) => void;
}) {
  return (
    <>
      <FormField label="Etiqueta superior" helper="Texto chico arriba del título. Vacío = no se muestra.">
        <input
          className="ek-input"
          value={value.eyebrow}
          onChange={(e) => onChange({ ...value, eyebrow: e.target.value })}
        />
      </FormField>
      <FormField label="Título">
        <input
          className="ek-input"
          value={value.titulo}
          onChange={(e) => onChange({ ...value, titulo: e.target.value })}
        />
      </FormField>
      <FormField
        label="Frase destacada (acento)"
        helper="Va en una segunda línea, en el color de acento. Vacío = sin highlight."
      >
        <input
          className="ek-input"
          value={value.titulo_accent}
          onChange={(e) => onChange({ ...value, titulo_accent: e.target.value })}
        />
      </FormField>
      <FormField label="Bajada" helper="Texto corto debajo del título. Vacío = no se muestra.">
        <textarea
          className="ek-input"
          rows={2}
          value={value.subtitulo}
          onChange={(e) => onChange({ ...value, subtitulo: e.target.value })}
        />
      </FormField>
    </>
  );
}

/** Sub-bloque con etiqueta dentro de una Section (separa varios headings). */
function SubBloque({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: '22px' }}>
      <p
        style={{
          fontSize: '12px',
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--sala-primary)',
          margin: '0 0 4px'
        }}
      >
        {label}
      </p>
      {hint && (
        <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', margin: '0 0 12px' }}>{hint}</p>
      )}
      {children}
    </div>
  );
}

function Section({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="ek-card"
      style={{ padding: '24px', marginBottom: '20px', display: 'block' }}
    >
      <p
        className="ek-eyebrow ek-eyebrow--mustard"
        style={{ marginBottom: '6px', fontSize: '11px' }}
      >
        {title}
      </p>
      <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '18px' }}>
        {description}
      </p>
      {children}
    </section>
  );
}

export default function AjustesLanding() {
  const { config, isLoading, isSaving, saveTopLevel } = useTenantConfigEditor();
  const toast = useToast();
  const tenant = useTenant();
  const [draft, setDraft] = useState<LandingDraft>(EMPTY);
  const [original, setOriginal] = useState<LandingDraft>(EMPTY);

  useEffect(() => {
    if (!config) return;
    const parsed = readLanding(config);
    setDraft(parsed);
    setOriginal(parsed);
  }, [config]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(original);

  async function handleSave() {
    const payload = {
      hero: {
        ...draft.hero,
        // Las imágenes del hero viven en `imagenes` (slides desktop+móvil).
        // Filtramos slides sin desktop y limpiamos las claves únicas viejas para
        // que `imagenes` sea la única fuente de verdad.
        imagenes: draft.hero.imagenes.filter((s) => s.desktop.trim().length > 0),
        image_url: '',
        image_url_mobile: ''
      },
      secciones: { ...draft.secciones },
      post_hero: { ...draft.post_hero },
      cta_final: { ...draft.cta_final },
      footer: {
        ...(((config?.landing as { footer?: Record<string, unknown> })?.footer) ?? {}),
        tagline: draft.footer.tagline,
        copyright: draft.footer.copyright,
        direccion: draft.footer.direccion || null,
        email: draft.footer.email || null
      },
      faq: draft.faq
        .map((f) => ({ pregunta: f.pregunta.trim(), respuesta: f.respuesta.trim() }))
        .filter((f) => f.pregunta || f.respuesta),
      mostrar_instructores: draft.mostrar_instructores
    };
    const { error } = await saveTopLevel({ landing: payload });
    if (error) {
      toast.error('No pudimos guardar los cambios. Prueba de nuevo.');
      return;
    }
    setOriginal(draft);
    toast.success('Cambios guardados.');
  }

  function handleDiscard() {
    if (window.confirm('¿Descartar los cambios sin guardar? Esta acción no se puede deshacer.')) {
      setDraft(original);
    }
  }

  // Helpers del carrusel del hero (slides desktop/móvil).
  function setSlideUrl(i: number, key: 'desktop' | 'mobile', url: string) {
    setDraft((d) => {
      const arr = [...d.hero.imagenes];
      arr[i] = { ...arr[i], [key]: url };
      return { ...d, hero: { ...d.hero, imagenes: arr } };
    });
  }
  function moverSlide(i: number, dir: number) {
    setDraft((d) => {
      const arr = [...d.hero.imagenes];
      const [m] = arr.splice(i, 1);
      arr.splice(i + dir, 0, m);
      return { ...d, hero: { ...d.hero, imagenes: arr } };
    });
  }
  function setSeccion(key: keyof LandingSecciones, v: LandingSeccionHeading) {
    setDraft((d) => ({ ...d, secciones: { ...d.secciones, [key]: v } }));
  }

  if (isLoading) {
    return (
      <div className="adm-page">
        <div className="ek-skeleton" style={{ height: '60px', marginBottom: '20px' }} />
        <div className="ek-skeleton" style={{ height: '400px' }} />
      </div>
    );
  }

  return (
    <div className="adm-page">
      <PageHeader
        title="Landing"
        subtitle="Edita el contenido que ven los visitantes en tu página pública."
        dirty={dirty}
      />

      <div style={{ position: 'sticky', top: '8px', zIndex: 5, marginBottom: '20px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>
          VISTA PREVIA EN VIVO
        </p>
        <LandingPreview
          hero={draft.hero}
          secciones={draft.secciones}
          postHero={draft.post_hero}
          ctaFinal={draft.cta_final}
          faq={draft.faq}
          footer={draft.footer}
          mostrarInstructores={draft.mostrar_instructores}
        />
      </div>

      <Section title="HERO" description="La primera impresión cuando alguien visita tu landing.">
        <p style={{ fontSize: '12px', color: 'var(--sala-text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
          Sube una o varias imágenes. Con varias, <strong>rotan solas en un carrusel</strong> (crossfade +
          movimiento sutil). Cada imagen tiene su versión <strong>desktop (16:9)</strong> y{' '}
          <strong>móvil (3:4)</strong>. Sin imágenes, el hero queda de texto sobre fondo claro.
        </p>

        {draft.hero.imagenes.map((slide, i) => (
          <div
            key={i}
            style={{
              border: '0.5px solid var(--ek-line)',
              borderRadius: '12px',
              padding: '14px',
              marginBottom: '12px',
              background: 'var(--ek-bg-soft)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
              <span className="ek-label" style={{ margin: 0 }}>Imagen {i + 1}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {i > 0 && (
                  <button type="button" aria-label="Subir" onClick={() => moverSlide(i, -1)} style={miniBtn}>↑</button>
                )}
                {i < draft.hero.imagenes.length - 1 && (
                  <button type="button" aria-label="Bajar" onClick={() => moverSlide(i, 1)} style={miniBtn}>↓</button>
                )}
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, hero: { ...d.hero, imagenes: d.hero.imagenes.filter((_, j) => j !== i) } }))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 600, color: 'var(--sala-error)' }}
                >
                  Quitar
                </button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
              <ImageUploader
                bucket="estudios"
                pathPrefix={`${tenant.slug}/hero-d-${i}`}
                currentUrl={slide.desktop || null}
                onUploaded={(url) => setSlideUrl(i, 'desktop', url)}
                label="Desktop (16:9)"
                cropAspect={16 / 9}
                previewMaxHeight={140}
                helperText="Foto horizontal para pantallas grandes."
              />
              <ImageUploader
                bucket="estudios"
                pathPrefix={`${tenant.slug}/hero-m-${i}`}
                currentUrl={slide.mobile || null}
                onUploaded={(url) => setSlideUrl(i, 'mobile', url)}
                label="Móvil (3:4) — opcional"
                cropAspect={3 / 4}
                previewMaxHeight={180}
                helperText="Vertical para celulares. Si no subes, en móvil se usa la de desktop."
              />
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={() => setDraft((d) => ({ ...d, hero: { ...d.hero, imagenes: [...d.hero.imagenes, { desktop: '', mobile: '' }] } }))}
          className="ek-cta ek-cta--secondary"
          style={{ marginTop: '2px' }}
        >
          + Agregar imagen
        </button>

        <FormField
          label="Estilo del hero"
          helper="Cómo se muestra la imagen del hero. Solo aplica cuando subes una imagen de fondo."
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {HERO_LAYOUT_OPTS.map((opt) => {
              const active = draft.hero.layout === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  title={opt.hint}
                  onClick={() => setDraft({ ...draft, hero: { ...draft.hero, layout: opt.value } })}
                  style={{
                    padding: '8px 16px',
                    borderRadius: '999px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    background: active ? 'var(--grad-primary)' : 'var(--sala-surface)',
                    color: active ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)',
                    border: `1px solid ${active ? 'var(--sala-primary)' : 'var(--sala-border)'}`
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </FormField>
        <FormField
          label="Etiqueta superior"
          helper="Texto pequeño que aparece arriba del título principal."
          count={draft.hero.eyebrow.length}
          max={40}
        >
          <input
            value={draft.hero.eyebrow}
            onChange={(e) => setDraft({ ...draft, hero: { ...draft.hero, eyebrow: e.target.value } })}
            className="ek-input"
            placeholder="SALA STUDIO · CULIACÁN"
          />
        </FormField>

        <FormField label="Título principal" count={draft.hero.titulo.length} max={48}>
          <input
            value={draft.hero.titulo}
            onChange={(e) => setDraft({ ...draft, hero: { ...draft.hero, titulo: e.target.value } })}
            className="ek-input"
            placeholder="Tu sala. Tu ritmo."
          />
        </FormField>

        <FormField
          label="Palabra destacada (mostaza)"
          helper="Aparece al final del título en color mostaza. Deja vacío si no quieres highlight."
          count={draft.hero.titulo_accent.length}
          max={40}
        >
          <input
            value={draft.hero.titulo_accent}
            onChange={(e) =>
              setDraft({ ...draft, hero: { ...draft.hero, titulo_accent: e.target.value } })
            }
            className="ek-input"
            placeholder="Sin límites."
          />
        </FormField>

        <FormField label="Subtítulo" helper="Descripción corta del producto." count={draft.hero.subtitulo.length} max={160}>
          <textarea
            value={draft.hero.subtitulo}
            onChange={(e) =>
              setDraft({ ...draft, hero: { ...draft.hero, subtitulo: e.target.value } })
            }
            className="ek-input"
            rows={3}
          />
        </FormField>

        <FormField
          label="Texto del botón principal"
          helper="El botón lleva automáticamente a la sección de membresías."
          count={draft.hero.cta_texto.length}
          max={28}
        >
          <input
            value={draft.hero.cta_texto}
            onChange={(e) =>
              setDraft({ ...draft, hero: { ...draft.hero, cta_texto: e.target.value } })
            }
            className="ek-input"
            placeholder="Ver membresías →"
          />
        </FormField>

        <FormField
          label="Texto del botón secundario"
          helper="Botón outline al lado del principal (lleva a membresías). Vacío = no se muestra."
          count={draft.hero.cta2_texto.length}
          max={28}
        >
          <input
            value={draft.hero.cta2_texto}
            onChange={(e) =>
              setDraft({ ...draft, hero: { ...draft.hero, cta2_texto: e.target.value } })
            }
            className="ek-input"
            placeholder="Ver horarios"
          />
        </FormField>
      </Section>

      <Section
        title="SECCIÓN DESPUÉS DEL HERO"
        description="Elige el formato de la sección que va abajo del hero (o ocultala). El contenido es el mismo para los tres formatos."
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
          {POST_HERO_VAR_OPTS.map((opt) => {
            const active = draft.post_hero.variante === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setDraft({ ...draft, post_hero: { ...draft.post_hero, variante: opt.value } })}
                style={{
                  padding: '8px 16px',
                  borderRadius: '999px',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  background: active ? 'var(--grad-primary)' : 'var(--sala-surface)',
                  color: active ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)',
                  border: `1px solid ${active ? 'var(--sala-primary)' : 'var(--sala-border)'}`
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {draft.post_hero.variante !== 'ninguna' && (
          <>
            <FormField label="Etiqueta superior">
              <input
                value={draft.post_hero.eyebrow}
                onChange={(e) => setDraft({ ...draft, post_hero: { ...draft.post_hero, eyebrow: e.target.value } })}
                className="ek-input"
                placeholder="CÓMO FUNCIONA"
              />
            </FormField>
            <FormField label="Título">
              <input
                value={draft.post_hero.titulo}
                onChange={(e) => setDraft({ ...draft, post_hero: { ...draft.post_hero, titulo: e.target.value } })}
                className="ek-input"
                placeholder="De cero a tu primera clase."
              />
            </FormField>
            <FormField label="Título (palabra destacada)" helper="Se muestra en el color de acento.">
              <input
                value={draft.post_hero.titulo_accent}
                onChange={(e) => setDraft({ ...draft, post_hero: { ...draft.post_hero, titulo_accent: e.target.value } })}
                className="ek-input"
                placeholder="En tres pasos."
              />
            </FormField>

            {draft.post_hero.items.map((it, i) => (
              <div key={i} style={{ borderTop: '1px solid var(--sala-border)', paddingTop: '14px', marginTop: '6px' }}>
                <FormField label={`Ítem ${i + 1} — título`}>
                  <input
                    value={it.titulo}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        post_hero: {
                          ...draft.post_hero,
                          items: draft.post_hero.items.map((x, idx) => (idx === i ? { ...x, titulo: e.target.value } : x))
                        }
                      })
                    }
                    className="ek-input"
                  />
                </FormField>
                <FormField label={`Ítem ${i + 1} — texto`}>
                  <textarea
                    value={it.texto}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        post_hero: {
                          ...draft.post_hero,
                          items: draft.post_hero.items.map((x, idx) => (idx === i ? { ...x, texto: e.target.value } : x))
                        }
                      })
                    }
                    className="ek-input"
                    rows={2}
                  />
                </FormField>
              </div>
            ))}
          </>
        )}
      </Section>

      <Section
        title="TÍTULOS DE LAS SECCIONES"
        description="Los encabezados de cada bloque de tu landing. El contenido (salas, planes, instructores) se edita en sus propias páginas; acá personalizas solo los títulos."
      >
        <SubBloque label="Salas">
          <SeccionHeadingFields value={draft.secciones.salas} onChange={(v) => setSeccion('salas', v)} />
        </SubBloque>
        <SubBloque label="Membresías">
          <SeccionHeadingFields
            value={draft.secciones.membresias}
            onChange={(v) => setSeccion('membresias', v)}
          />
        </SubBloque>
        <SubBloque label="Instructores" hint="Se muestra solo si activas la sección de instructores abajo.">
          <SeccionHeadingFields
            value={draft.secciones.instructores}
            onChange={(v) => setSeccion('instructores', v)}
          />
        </SubBloque>
      </Section>

      <Section
        title="SECCIONES"
        description="Enciende o apaga bloques opcionales de tu landing pública."
      >
        <Toggle
          checked={draft.mostrar_instructores}
          onChange={(v) => setDraft({ ...draft, mostrar_instructores: v })}
          label="Sección de instructores"
          description="Muestra a tu equipo de instructores en tu página pública. Se muestran todos los instructores activos."
        />
      </Section>

      <Section title="CALL TO ACTION FINAL" description="El último empujón antes del footer.">
        <FormField label="Etiqueta superior" count={draft.cta_final.eyebrow.length} max={40}>
          <input
            value={draft.cta_final.eyebrow}
            onChange={(e) =>
              setDraft({ ...draft, cta_final: { ...draft.cta_final, eyebrow: e.target.value } })
            }
            className="ek-input"
            placeholder="CULIACÁN · MÉXICO"
          />
        </FormField>

        <FormField label="Título" count={draft.cta_final.titulo.length} max={48}>
          <input
            value={draft.cta_final.titulo}
            onChange={(e) =>
              setDraft({ ...draft, cta_final: { ...draft.cta_final, titulo: e.target.value } })
            }
            className="ek-input"
          />
        </FormField>

        <FormField label="Subtítulo" count={draft.cta_final.subtitulo.length} max={160}>
          <textarea
            value={draft.cta_final.subtitulo}
            onChange={(e) =>
              setDraft({ ...draft, cta_final: { ...draft.cta_final, subtitulo: e.target.value } })
            }
            className="ek-input"
            rows={2}
          />
        </FormField>

        <FormField
          label="Texto del botón"
          helper={'El número de WhatsApp se configura en "Contacto".'}
          count={draft.cta_final.cta_texto.length}
          max={32}
        >
          <input
            value={draft.cta_final.cta_texto}
            onChange={(e) =>
              setDraft({ ...draft, cta_final: { ...draft.cta_final, cta_texto: e.target.value } })
            }
            className="ek-input"
            placeholder="Cuentactanos por WhatsApp →"
          />
        </FormField>
      </Section>

      <Section title="FOOTER" description="El pie de página de tu landing.">
        <p
          style={{
            fontSize: '12px',
            color: 'var(--sala-text-secondary)',
            background: 'var(--ek-bg-soft)',
            border: '1px solid var(--ek-line)',
            borderRadius: '10px',
            padding: '10px 12px',
            margin: '0 0 18px',
            lineHeight: 1.5
          }}
        >
          El WhatsApp y las redes sociales del footer se configuran en{' '}
          <Link to="/admin/contacto" style={{ color: 'var(--sala-primary)', fontWeight: 600 }}>
            Ajustes › Contacto
          </Link>
          .
        </p>
        <FormField label="Tagline (debajo del logo)">
          <input
            value={draft.footer.tagline}
            onChange={(e) =>
              setDraft({ ...draft, footer: { ...draft.footer, tagline: e.target.value } })
            }
            className="ek-input"
            placeholder="STUDIO · CULIACÁN"
          />
        </FormField>

        <FormField label="Copyright" helper="El año se agrega automáticamente.">
          <input
            value={draft.footer.copyright}
            onChange={(e) =>
              setDraft({ ...draft, footer: { ...draft.footer, copyright: e.target.value } })
            }
            className="ek-input"
            placeholder="Todos los derechos reservados."
          />
        </FormField>

        <FormField label="Dirección" helper="Opcional. Si la dejas vacía, no aparece en el footer.">
          <input
            value={draft.footer.direccion}
            onChange={(e) =>
              setDraft({ ...draft, footer: { ...draft.footer, direccion: e.target.value } })
            }
            className="ek-input"
            placeholder="Av. ... (opcional)"
          />
        </FormField>

        <FormField label="Email" helper="Opcional. Si la dejas vacía, no aparece en el footer.">
          <input
            type="email"
            value={draft.footer.email}
            onChange={(e) =>
              setDraft({ ...draft, footer: { ...draft.footer, email: e.target.value } })
            }
            className="ek-input"
            placeholder="contacto@salastudio.com"
          />
        </FormField>
      </Section>

      <Section title="PREGUNTAS FRECUENTES" description="Las preguntas que ven tus visitantes. Editalas a tu realidad. Sin preguntas = la sección no se muestra.">
        <SubBloque label="Encabezado de la sección">
          <SeccionHeadingFields value={draft.secciones.faq} onChange={(v) => setSeccion('faq', v)} />
        </SubBloque>
        <p
          style={{
            fontSize: '12px',
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--sala-primary)',
            margin: '0 0 12px'
          }}
        >
          Preguntas
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {draft.faq.map((item, i) => (
            <div key={i} style={{ border: '1px solid var(--sala-border)', borderRadius: '12px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--sala-text-tertiary)' }}>Pregunta {i + 1}</span>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, faq: draft.faq.filter((_, j) => j !== i) })}
                  className="ek-cta ek-cta--secondary"
                  style={{ fontSize: '12px', padding: '4px 10px' }}
                >
                  Quitar
                </button>
              </div>
              <input
                className="ek-input"
                value={item.pregunta}
                placeholder="¿La pregunta?"
                maxLength={140}
                onChange={(e) => setDraft({ ...draft, faq: draft.faq.map((f, j) => (j === i ? { ...f, pregunta: e.target.value } : f)) })}
              />
              <textarea
                className="ek-input"
                rows={2}
                value={item.respuesta}
                placeholder="La respuesta."
                maxLength={500}
                onChange={(e) => setDraft({ ...draft, faq: draft.faq.map((f, j) => (j === i ? { ...f, respuesta: e.target.value } : f)) })}
              />
            </div>
          ))}
          {draft.faq.length === 0 && (
            <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', margin: 0 }}>
              Sin preguntas — la sección no se muestra en la landing.
            </p>
          )}
          {draft.faq.length < 12 && (
            <button
              type="button"
              onClick={() => setDraft({ ...draft, faq: [...draft.faq, { pregunta: '', respuesta: '' }] })}
              className="ek-cta ek-cta--secondary"
              style={{ alignSelf: 'flex-start' }}
            >
              + Agregar pregunta
            </button>
          )}
        </div>
      </Section>

      <div style={{ display: 'flex', gap: '10px', position: 'sticky', bottom: '12px' }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || isSaving}
          className="ek-cta"
          style={{ padding: '14px 28px', fontSize: '14px' }}
        >
          {isSaving ? 'Guardando…' : 'Guardar cambios'}
        </button>
        <button
          type="button"
          onClick={handleDiscard}
          disabled={!dirty || isSaving}
          className="ek-cta ek-cta--secondary"
          style={{ padding: '14px 28px', fontSize: '14px' }}
        >
          Descartar
        </button>
      </div>
    </div>
  );
}
