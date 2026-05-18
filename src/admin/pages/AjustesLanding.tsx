import { useEffect, useState } from 'react';
import { useTenantConfigEditor } from '../hooks/useTenantConfigEditor';
import { useToast } from '@shared/hooks/useToast';

type HeroDraft = {
  eyebrow: string;
  titulo: string;
  titulo_accent: string;
  subtitulo: string;
  cta_texto: string;
  cta_link: string;
};

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

type LandingDraft = {
  hero: HeroDraft;
  cta_final: CtaFinalDraft;
  footer: FooterDraft;
};

const EMPTY: LandingDraft = {
  hero: { eyebrow: '', titulo: '', titulo_accent: '', subtitulo: '', cta_texto: '', cta_link: '' },
  cta_final: { eyebrow: '', titulo: '', subtitulo: '', cta_texto: '' },
  footer: { tagline: '', copyright: '', direccion: '', email: '' }
};

function readLanding(config: Record<string, unknown> | null): LandingDraft {
  const landing = (config?.landing ?? {}) as Record<string, unknown>;
  const hero = (landing.hero ?? {}) as Record<string, unknown>;
  const ctaFinal = (landing.cta_final ?? {}) as Record<string, unknown>;
  const footer = (landing.footer ?? {}) as Record<string, unknown>;
  return {
    hero: {
      eyebrow: String(hero.eyebrow ?? ''),
      titulo: String(hero.titulo ?? ''),
      titulo_accent: String(hero.titulo_accent ?? ''),
      subtitulo: String(hero.subtitulo ?? ''),
      cta_texto: String(hero.cta_texto ?? ''),
      cta_link: String(hero.cta_link ?? '')
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
    }
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
      cta_final: { ...draft.cta_final },
      footer: {
        ...(((config?.landing as { footer?: Record<string, unknown> })?.footer) ?? {}),
        tagline: draft.footer.tagline,
        copyright: draft.footer.copyright,
        direccion: draft.footer.direccion || null,
        email: draft.footer.email || null
      }
    };
    const { error } = await saveTopLevel({ landing: payload });
    if (error) {
      toast.error(`No se pudo guardar: ${error}`);
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

      <Section title="HERO" description="La primera impresión cuando alguien visita tu landing.">
        <FormField
          label="Etiqueta superior"
          helper="Texto pequeño que aparece arriba del título principal."
        >
          <input
            value={draft.hero.eyebrow}
            onChange={(e) => setDraft({ ...draft, hero: { ...draft.hero, eyebrow: e.target.value } })}
            className="ek-input"
            placeholder="EKKO STUDIO · CULIACÁN"
          />
        </FormField>

        <FormField label="Título principal">
          <input
            value={draft.hero.titulo}
            onChange={(e) => setDraft({ ...draft, hero: { ...draft.hero, titulo: e.target.value } })}
            className="ek-input"
            placeholder="Tu estudio. Tu contenido."
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

        <FormField label="Texto del botón principal">
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
          label="A dónde lleva el botón"
          helper="Puede ser anchor (#nombre) o URL completa (https://...)."
        >
          <input
            value={draft.hero.cta_link}
            onChange={(e) =>
              setDraft({ ...draft, hero: { ...draft.hero, cta_link: e.target.value } })
            }
            className="ek-input"
            placeholder="#membresias"
          />
        </FormField>
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
            placeholder="contacto@ekkostudio.com"
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
