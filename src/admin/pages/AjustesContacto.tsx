import { useEffect, useState } from 'react';
import { useTenantConfigEditor } from '../hooks/useTenantConfigEditor';
import { useToast } from '@shared/hooks/useToast';

type ContactoDraft = {
  whatsapp_e164: string;
  whatsapp_mensaje_default: string;
};

type RedesDraft = {
  instagram: string;
  tiktok: string;
  youtube: string;
  facebook: string;
};

const URL_REGEX = /^https?:\/\/.+/i;

function readDraft(config: Record<string, unknown> | null): {
  contacto: ContactoDraft;
  redes: RedesDraft;
} {
  const contacto = (config?.contacto ?? {}) as Record<string, unknown>;
  const landing = (config?.landing ?? {}) as Record<string, unknown>;
  const footer = (landing.footer ?? {}) as Record<string, unknown>;
  const redes = (footer.redes ?? {}) as Record<string, unknown>;

  return {
    contacto: {
      whatsapp_e164: String(contacto.whatsapp_e164 ?? ''),
      whatsapp_mensaje_default: String(contacto.whatsapp_mensaje_default ?? '')
    },
    redes: {
      instagram: redes.instagram == null ? '' : String(redes.instagram),
      tiktok: redes.tiktok == null ? '' : String(redes.tiktok),
      youtube: redes.youtube == null ? '' : String(redes.youtube),
      facebook: redes.facebook == null ? '' : String(redes.facebook)
    }
  };
}

function FormField({
  label,
  helper,
  error,
  children
}: {
  label: string;
  helper?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ek-form-field" style={{ marginBottom: '14px' }}>
      <label className="ek-label">{label}</label>
      {children}
      {(error || helper) && (
        <p
          style={{
            fontSize: '11px',
            color: error ? 'var(--ek-danger)' : 'var(--ek-ink-faint)',
            marginTop: '6px'
          }}
        >
          {error || helper}
        </p>
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

export default function AjustesContacto() {
  const { config, isLoading, isSaving, saveTopLevel } = useTenantConfigEditor();
  const toast = useToast();
  const [contacto, setContacto] = useState<ContactoDraft>({ whatsapp_e164: '', whatsapp_mensaje_default: '' });
  const [redes, setRedes] = useState<RedesDraft>({ instagram: '', tiktok: '', youtube: '', facebook: '' });
  const [originalJson, setOriginalJson] = useState('');

  useEffect(() => {
    if (!config) return;
    const { contacto: c, redes: r } = readDraft(config);
    setContacto(c);
    setRedes(r);
    setOriginalJson(JSON.stringify({ contacto: c, redes: r }));
  }, [config]);

  const currentJson = JSON.stringify({ contacto, redes });
  const dirty = currentJson !== originalJson;

  const whatsappValido = !contacto.whatsapp_e164 || /^\d{10,15}$/.test(contacto.whatsapp_e164);
  const redesInvalidas: Array<keyof RedesDraft> = (
    Object.keys(redes) as Array<keyof RedesDraft>
  ).filter((k) => redes[k] !== '' && !URL_REGEX.test(redes[k]));

  async function handleSave() {
    if (!whatsappValido) {
      toast.error('El número de WhatsApp debe ser solo dígitos (10–15).');
      return;
    }
    if (redesInvalidas.length > 0) {
      toast.error('Las URLs de redes deben empezar con http:// o https://');
      return;
    }

    // Merge no destructivo: preservar otras keys de landing.footer
    const landing = (config?.landing ?? {}) as Record<string, unknown>;
    const footer = (landing.footer ?? {}) as Record<string, unknown>;

    const patch = {
      contacto: {
        whatsapp_e164: contacto.whatsapp_e164,
        whatsapp_mensaje_default: contacto.whatsapp_mensaje_default
      },
      landing: {
        ...landing,
        footer: {
          ...footer,
          redes: {
            instagram: redes.instagram || null,
            tiktok: redes.tiktok || null,
            youtube: redes.youtube || null,
            facebook: redes.facebook || null
          }
        }
      }
    };

    const { error } = await saveTopLevel(patch);
    if (error) {
      toast.error(`No se pudo guardar: ${error}`);
      return;
    }
    setOriginalJson(currentJson);
    toast.success('Cambios guardados.');
  }

  function handleDiscard() {
    if (!config) return;
    const { contacto: c, redes: r } = readDraft(config);
    setContacto(c);
    setRedes(r);
  }

  if (isLoading) {
    return (
      <div className="adm-page">
        <div className="ek-skeleton" style={{ height: '60px', marginBottom: '20px' }} />
        <div className="ek-skeleton" style={{ height: '300px' }} />
      </div>
    );
  }

  return (
    <div className="adm-page">
      <p className="ek-eyebrow" style={{ marginBottom: '4px' }}>AJUSTES</p>
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
        Contacto
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '24px' }}>
        Cómo te contactan tus clientes y dónde ven tus redes.
      </p>

      <Section title="WHATSAPP" description="Tu canal principal de contacto.">
        <FormField
          label="Número de WhatsApp"
          helper="Solo dígitos. Sin '+' ni espacios. Ejemplo: 5216671234567 (10–15 dígitos)."
          error={!whatsappValido ? 'Formato inválido. Solo dígitos, 10–15 caracteres.' : undefined}
        >
          <input
            type="text"
            inputMode="numeric"
            value={contacto.whatsapp_e164}
            onChange={(e) =>
              setContacto({ ...contacto, whatsapp_e164: e.target.value.replace(/\D/g, '') })
            }
            className="ek-input"
            placeholder="5216671234567"
          />
        </FormField>

        <FormField
          label="Mensaje predeterminado"
          helper="Lo que se autocompleta cuando un visitante hace click en el botón de WhatsApp."
        >
          <input
            value={contacto.whatsapp_mensaje_default}
            onChange={(e) =>
              setContacto({ ...contacto, whatsapp_mensaje_default: e.target.value })
            }
            className="ek-input"
            placeholder="Hola, me interesa saber más sobre..."
          />
        </FormField>
      </Section>

      <Section
        title="REDES SOCIALES"
        description="Solo aparecen en tu landing las redes que tengan URL."
      >
        {(['instagram', 'tiktok', 'youtube', 'facebook'] as const).map((red) => (
          <FormField
            key={red}
            label={red.charAt(0).toUpperCase() + red.slice(1)}
            error={
              redes[red] !== '' && !URL_REGEX.test(redes[red])
                ? 'Debe empezar con http:// o https://'
                : undefined
            }
            helper={redes[red] === '' ? 'Opcional. Si la dejás vacía, no aparece.' : undefined}
          >
            <input
              type="url"
              value={redes[red]}
              onChange={(e) => setRedes({ ...redes, [red]: e.target.value })}
              className="ek-input"
              placeholder={`https://${red}.com/tu-cuenta`}
            />
          </FormField>
        ))}
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
