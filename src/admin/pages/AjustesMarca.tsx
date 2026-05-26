import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import ImageUploader from '../components/ImageUploader';

type BrandingDraft = {
  logo_url_dark: string | null;
  isotipo_url: string | null;
  og_image_url: string | null;
  favicon_url: string | null;
};

const EMPTY: BrandingDraft = {
  logo_url_dark: null,
  isotipo_url: null,
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
    isotipo_url: typeof b.isotipo_url === 'string' ? b.isotipo_url : null,
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
      toast.error('No pudimos guardar los cambios. Probá de nuevo.');
      return;
    }
    setOriginalJson(JSON.stringify(draft));
    toast.success('Marca actualizada. Recargá para ver los cambios en sidebar.');
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
        title="LOGO PRINCIPAL (HORIZONTAL)"
        description="Símbolo + nombre de tu marca en formato horizontal. Aparece en headers de la app (member/admin/recepción), landing público y sidebar admin. Recomendado: PNG/SVG transparente, ratio ~3:1, 512×170px."
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
            Mientras no subas tu logo, se muestra el logo de SALA como placeholder.
          </p>
        )}
      </Section>

      <Section
        title="ISOTIPO (SÍMBOLO CUADRADO)"
        description="Solo el símbolo de tu marca, sin texto, cuadrado. Aparece en el login y espacios chicos."
      >
        <ImageUploader
          bucket="logos"
          pathPrefix={`${tenant.slug}/isotipo`}
          currentUrl={draft.isotipo_url}
          onUploaded={(url) => setDraft({ ...draft, isotipo_url: url || null })}
          label=""
          helperText="Símbolo cuadrado (sin texto). PNG o SVG, fondo transparente, 512×512 mínimo. Aparece en el login y espacios chicos."
        />
        {!draft.isotipo_url && (
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Mientras no subas tu isotipo, se muestra el isotipo de SALA como placeholder.
          </p>
        )}
      </Section>

      <Section
        title="IMAGEN PARA REDES (OPEN GRAPH)"
        description="Aparecerá cuando alguien comparta tu landing en WhatsApp, Twitter, Facebook. Recomendado: 1200×630px JPG/PNG."
        proximamente="Sistema en desarrollo (D-018) — todavía no se aplica al compartir. Esperá a habilitarlo."
      >
        <DisabledPlaceholder current={draft.og_image_url} kind="image" />
      </Section>

      <Section
        title="FAVICON"
        description="Aparecerá en la pestaña del navegador. Recomendado: 32×32px o 64×64px PNG transparente."
        proximamente="Sistema en desarrollo (D-016) — la pestaña todavía muestra el favicon de SALA. Esperá a habilitarlo."
      >
        <DisabledPlaceholder current={draft.favicon_url} kind="image" />
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
  proximamente,
  children
}: {
  title: string;
  description: string;
  /** Si está, muestra un badge "Próximamente" + nota explicativa. */
  proximamente?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="ek-card"
      style={{
        padding: '24px',
        marginBottom: '20px',
        display: 'block',
        opacity: proximamente ? 0.7 : 1
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
        <p
          className="ek-eyebrow ek-eyebrow--mustard"
          style={{ margin: 0, fontSize: '11px' }}
        >
          {title}
        </p>
        {proximamente && (
          <span
            style={{
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.10em',
              textTransform: 'uppercase',
              color: 'var(--sala-warning)',
              background: 'var(--sala-warning-bg)',
              padding: '3px 8px',
              borderRadius: '999px',
              border: '1px solid rgba(200, 148, 31, 0.3)'
            }}
          >
            Próximamente
          </span>
        )}
      </div>
      <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: proximamente ? '8px' : '18px' }}>
        {description}
      </p>
      {proximamente && (
        <p
          style={{
            fontSize: '12px',
            color: 'var(--sala-warning)',
            margin: 0,
            marginBottom: '14px',
            fontStyle: 'italic'
          }}
        >
          ⏳ {proximamente}
        </p>
      )}
      {children}
    </section>
  );
}

/**
 * Placeholder visual mientras la pieza de marca no se aplica aún (D-016/D-018).
 * Mantiene el aspecto del uploader pero sin permitir subir, para evitar UX
 * engañosa ("subí mi favicon" → no pasa nada en la pestaña).
 */
function DisabledPlaceholder({ current, kind }: { current: string | null; kind: 'image' }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        padding: '14px 16px',
        background: 'var(--sala-surface)',
        border: '1px dashed var(--sala-border-strong)',
        borderRadius: '12px',
        cursor: 'not-allowed'
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: '48px',
          height: '48px',
          background: 'var(--sala-bg)',
          border: '1px solid var(--sala-border)',
          borderRadius: '10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '22px',
          flexShrink: 0
        }}
      >
        {kind === 'image' ? '🖼' : '📁'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontSize: '13px',
            color: 'var(--sala-text-primary)',
            margin: 0,
            marginBottom: '4px',
            fontWeight: 600
          }}
        >
          Carga deshabilitada por ahora
        </p>
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0, lineHeight: 1.4 }}>
          {current
            ? 'Hay un archivo subido pero todavía no se aplica al sistema. Lo activamos cuando habilitemos esta pieza.'
            : 'Cuando habilitemos esta pieza vas a poder subir tu archivo desde acá.'}
        </p>
      </div>
    </div>
  );
}
