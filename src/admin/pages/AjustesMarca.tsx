import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import ImageUploader from '../components/ImageUploader';

type BrandingDraft = {
  logo_url_dark: string | null;
  og_image_url: string | null;
  favicon_url: string | null;
};

const EMPTY: BrandingDraft = {
  logo_url_dark: null,
  og_image_url: null,
  favicon_url: null
};

function readBranding(branding: unknown): BrandingDraft {
  if (!branding || typeof branding !== 'object') return EMPTY;
  const b = branding as Record<string, unknown>;
  return {
    logo_url_dark: typeof b.logo_url_dark === 'string'
      ? b.logo_url_dark
      : typeof b.logo_url === 'string'
        ? b.logo_url
        : null,
    og_image_url: typeof b.og_image_url === 'string' ? b.og_image_url : null,
    favicon_url: typeof b.favicon_url === 'string' ? b.favicon_url : null
  };
}

export default function AjustesMarca() {
  const tenant = useTenant();
  const toast = useToast();
  const [draft, setDraft] = useState<BrandingDraft>(EMPTY);
  const [originalJson, setOriginalJson] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const loadBranding = useCallback(async () => {
    const { data, error } = await supabase
      .from('tenants')
      .select('branding')
      .eq('id', tenant.id)
      .single();
    if (error) {
      console.error('[AjustesMarca]', error);
      return;
    }
    const parsed = readBranding(data?.branding);
    setDraft(parsed);
    setOriginalJson(JSON.stringify(parsed));
  }, [tenant.id]);

  useEffect(() => {
    void loadBranding();
  }, [loadBranding]);

  const dirty = JSON.stringify(draft) !== originalJson;

  async function handleSave() {
    setIsSaving(true);

    // Merge no destructivo con otras keys (color_primary, etc.)
    const { data: current } = await supabase
      .from('tenants')
      .select('branding')
      .eq('id', tenant.id)
      .single();

    const currentBranding =
      (current?.branding as Record<string, unknown> | null) ?? {};
    const next = { ...currentBranding, ...draft };

    const { error } = await supabase
      .from('tenants')
      .update({ branding: next as never })
      .eq('id', tenant.id);

    setIsSaving(false);
    if (error) {
      toast.error(`No se pudo guardar: ${error.message}`);
      return;
    }
    setOriginalJson(JSON.stringify(draft));
    toast.success('Marca actualizada. Recarga para ver los cambios en sidebar.');
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
        Marca
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '28px' }}>
        Personaliza la identidad visual de tu marca.
      </p>

      <Section
        title="LOGO PRINCIPAL"
        description="Aparece en sidebar admin, headers y footer público. Recomendado: PNG transparente, fondo oscuro, 512×128px."
      >
        <ImageUploader
          bucket="logos"
          pathPrefix={`${tenant.slug}/logo-dark`}
          currentUrl={draft.logo_url_dark}
          onUploaded={(url) => setDraft({ ...draft, logo_url_dark: url || null })}
          label=""
          helperText="PNG / WEBP / SVG. Máx 2MB."
        />
        {!draft.logo_url_dark && (
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Por ahora se muestra el texto &quot;{tenant.nombre.split(/\s+/)[0]}&quot; como logo.
          </p>
        )}
      </Section>

      <Section
        title="IMAGEN PARA REDES (OPEN GRAPH)"
        description="Aparece cuando alguien comparte tu landing en WhatsApp, Twitter, Facebook. Recomendado: 1200×630px JPG/PNG."
      >
        <ImageUploader
          bucket="logos"
          pathPrefix={`${tenant.slug}/og-image`}
          currentUrl={draft.og_image_url}
          onUploaded={(url) => setDraft({ ...draft, og_image_url: url || null })}
          label=""
          helperText="JPG / PNG / WEBP. Máx 2MB."
        />
      </Section>

      <Section
        title="FAVICON"
        description="Aparece en la pestaña del navegador. Recomendado: 32×32px o 64×64px PNG transparente."
      >
        <ImageUploader
          bucket="logos"
          pathPrefix={`${tenant.slug}/favicon`}
          currentUrl={draft.favicon_url}
          onUploaded={(url) => setDraft({ ...draft, favicon_url: url || null })}
          label=""
          helperText="PNG / ICO. Máx 2MB."
        />
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
      </div>

      <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '16px' }}>
        Nota: OG image y favicon dinámicos requieren recargar la página para verse. La
        sincronización en tiempo real con &lt;meta&gt; tags llega en sprint posterior.
      </p>
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
