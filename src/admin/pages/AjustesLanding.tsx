import { useEffect, useState } from 'react';
import { useTenantConfigEditor } from '../hooks/useTenantConfigEditor';
import { useToast } from '@shared/hooks/useToast';
import { useTenant } from '@shared/hooks/useTenant';
import Toggle from '../components/Toggle';
import ImageUploader from '../components/ImageUploader';
import LandingPreview from '../components/LandingPreview';

type HeroLayout = 'contenido' | 'completo';
type HeroDraft = {
  eyebrow: string;
  titulo: string;
  titulo_accent: string;
  subtitulo: string;
  cta_texto: string;
  cta_link: string;
  image_url: string;
  image_url_mobile: string;
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
    { titulo: 'Elegí tu plan', texto: 'Pickeá la membresía que va con tu ritmo. Sin permanencia rara, sin letra chica.' },
    { titulo: 'Reservá desde la app', texto: 'Elegí sala, día y horario en segundos. Sin llamadas, sin esperar.' },
    { titulo: 'Llegá y entrená', texto: 'Mostrá tu QR en recepción y listo. Las salas ya están montadas con todo el equipo.' }
  ]
};

type LandingDraft = {
  hero: HeroDraft;
  post_hero: PostHeroDraft;
  cta_final: CtaFinalDraft;
  footer: FooterDraft;
  mostrar_instructores: boolean;
};

const EMPTY: LandingDraft = {
  hero: { eyebrow: '', titulo: '', titulo_accent: '', subtitulo: '', cta_texto: '', cta_link: '', image_url: '', image_url_mobile: '', layout: 'contenido' },
  post_hero: POST_HERO_DEFAULT,
  cta_final: { eyebrow: '', titulo: '', subtitulo: '', cta_texto: '' },
  footer: { tagline: '', copyright: '', direccion: '', email: '' },
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
      cta_link: String(hero.cta_link ?? ''),
      image_url: String(hero.image_url ?? ''),
      image_url_mobile: String(hero.image_url_mobile ?? ''),
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
    mostrar_instructores: landing.mostrar_instructores === true
  };
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
  children
}: {
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ek-form-field" style={{ marginBottom: '14px' }}>
      <label className="ek-label">{label}</label>
      {children}
      {helper && (
        <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>{helper}</p>
      )}
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
      hero: { ...draft.hero },
      post_hero: { ...draft.post_hero },
      cta_final: { ...draft.cta_final },
      footer: {
        ...(((config?.landing as { footer?: Record<string, unknown> })?.footer) ?? {}),
        tagline: draft.footer.tagline,
        copyright: draft.footer.copyright,
        direccion: draft.footer.direccion || null,
        email: draft.footer.email || null
      },
      mostrar_instructores: draft.mostrar_instructores
    };
    const { error } = await saveTopLevel({ landing: payload });
    if (error) {
      toast.error('No pudimos guardar los cambios. Probá de nuevo.');
      return;
    }
    setOriginal(draft);
    toast.success('Cambios guardados.');
  }

  function handleDiscard() {
    setDraft(original);
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
        <div style={{ maxHeight: '46vh', overflow: 'hidden', borderRadius: '14px' }}>
          <LandingPreview hero={draft.hero} postHero={draft.post_hero} />
        </div>
      </div>

      <Section title="HERO" description="La primera impresión cuando alguien visita tu landing.">
        <ImageUploader
          bucket="estudios"
          pathPrefix={`${tenant.slug}/hero-desktop`}
          currentUrl={draft.hero.image_url || null}
          onUploaded={(url) => setDraft({ ...draft, hero: { ...draft.hero, image_url: url } })}
          label="Imagen de fondo — Desktop (opcional)"
          cropAspect={16 / 9}
          previewMaxHeight={200}
          helperText="Foto horizontal para pantallas grandes. Recorte 16:9. Sin imagen, el hero queda de texto sobre fondo claro."
        />
        <ImageUploader
          bucket="estudios"
          pathPrefix={`${tenant.slug}/hero-mobile`}
          currentUrl={draft.hero.image_url_mobile || null}
          onUploaded={(url) => setDraft({ ...draft, hero: { ...draft.hero, image_url_mobile: url } })}
          label="Imagen de fondo — Móvil (opcional)"
          cropAspect={3 / 4}
          previewMaxHeight={220}
          helperText="Foto vertical para celulares. Recorte 3:4. Si no subís una, en móvil se usa la de desktop."
        />
        <FormField
          label="Estilo del hero"
          helper="Cómo se muestra la imagen del hero. Solo aplica cuando subís una imagen de fondo."
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
        >
          <input
            value={draft.hero.eyebrow}
            onChange={(e) => setDraft({ ...draft, hero: { ...draft.hero, eyebrow: e.target.value } })}
            className="ek-input"
            placeholder="SALA STUDIO · CULIACÁN"
          />
        </FormField>

        <FormField label="Título principal">
          <input
            value={draft.hero.titulo}
            onChange={(e) => setDraft({ ...draft, hero: { ...draft.hero, titulo: e.target.value } })}
            className="ek-input"
            placeholder="Tu sala. Tu ritmo."
          />
        </FormField>

        <FormField
          label="Palabra destacada (mostaza)"
          helper="Aparece al final del título en color mostaza. Dejá vacío si no querés highlight."
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

        <FormField label="Subtítulo" helper="Descripción corta del producto.">
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
      </Section>

      <Section
        title="SECCIÓN DESPUÉS DEL HERO"
        description="Elegí el formato de la sección que va abajo del hero (o ocultala). El contenido es el mismo para los tres formatos."
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
        title="SECCIONES"
        description="Encendé o apagá bloques opcionales de tu landing pública."
      >
        <Toggle
          checked={draft.mostrar_instructores}
          onChange={(v) => setDraft({ ...draft, mostrar_instructores: v })}
          label="Sección de instructores"
          description="Mostrá a tu equipo de instructores en tu página pública. Se muestran todos los instructores activos."
        />
      </Section>

      <Section title="CALL TO ACTION FINAL" description="El último empujón antes del footer.">
        <FormField label="Etiqueta superior">
          <input
            value={draft.cta_final.eyebrow}
            onChange={(e) =>
              setDraft({ ...draft, cta_final: { ...draft.cta_final, eyebrow: e.target.value } })
            }
            className="ek-input"
            placeholder="CULIACÁN · MÉXICO"
          />
        </FormField>

        <FormField label="Título">
          <input
            value={draft.cta_final.titulo}
            onChange={(e) =>
              setDraft({ ...draft, cta_final: { ...draft.cta_final, titulo: e.target.value } })
            }
            className="ek-input"
          />
        </FormField>

        <FormField label="Subtítulo">
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
        >
          <input
            value={draft.cta_final.cta_texto}
            onChange={(e) =>
              setDraft({ ...draft, cta_final: { ...draft.cta_final, cta_texto: e.target.value } })
            }
            className="ek-input"
            placeholder="Contáctanos por WhatsApp →"
          />
        </FormField>
      </Section>

      <Section title="FOOTER" description="El pie de página de tu landing.">
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

        <FormField label="Dirección" helper="Opcional. Si la dejás vacía, no aparece en el footer.">
          <input
            value={draft.footer.direccion}
            onChange={(e) =>
              setDraft({ ...draft, footer: { ...draft.footer, direccion: e.target.value } })
            }
            className="ek-input"
            placeholder="Av. ... (opcional)"
          />
        </FormField>

        <FormField label="Email" helper="Opcional. Si la dejás vacía, no aparece en el footer.">
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
