import { useCallback, useEffect, useState } from 'react';
import { Image as ImageIcon, Folder, AlertTriangle } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant, useTenantRefetch } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import {
  applyBranding,
  contrastRatio,
  pickTextOn,
  relativeLuminance
} from '@shared/providers/TenantProvider';
import ImageUploader from '../components/ImageUploader';

const SALA_DEFAULT_PRIMARY = '#3D6B52';
const SALA_DEFAULT_ACCENT  = '#3D6B52';

type BrandingDraft = {
  logo_url_dark: string | null;
  isotipo_url: string | null;
  og_image_url: string | null;
  favicon_url: string | null;
  color_primary: string;
  color_accent: string;
};

const EMPTY: BrandingDraft = {
  logo_url_dark: null,
  isotipo_url: null,
  og_image_url: null,
  favicon_url: null,
  color_primary: SALA_DEFAULT_PRIMARY,
  color_accent: SALA_DEFAULT_ACCENT
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
    favicon_url: typeof b.favicon_url === 'string' ? b.favicon_url : null,
    color_primary: typeof b.color_primary === 'string' ? b.color_primary : SALA_DEFAULT_PRIMARY,
    color_accent:  typeof b.color_accent  === 'string' ? b.color_accent  : SALA_DEFAULT_ACCENT
  };
}

function isValidHex(s: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(s);
}

/**
 * Normaliza un input hex que el usuario puede haber tipeado de varias formas:
 *   "#3D6B52" / "3D6B52" / "#3d6b52" / "3d6b52" / "#FFF" / "fff" / "FFF"
 *
 * Acepta: 3 o 6 dígitos hex, con o sin '#', case-insensitive.
 * Expande la forma corta (#RGB → #RRGGBB).
 * Devuelve hex canónico "#RRGGBB" (uppercase) o null si el formato es inválido.
 */
function normalizeHex(input: string): string | null {
  const trimmed = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(trimmed)) return '#' + trimmed.toUpperCase();
  if (/^[0-9a-f]{3}$/i.test(trimmed)) {
    const expanded = trimmed.split('').map((c) => c + c).join('');
    return '#' + expanded.toUpperCase();
  }
  return null;
}

export default function AjustesMarca() {
  const tenant = useTenant();
  const refetchTenant = useTenantRefetch();
  const toast = useToast();
  const [draft, setDraft] = useState<BrandingDraft>(EMPTY);
  const [persisted, setPersisted] = useState<BrandingDraft>(EMPTY);
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
    setPersisted(parsed);
    setOriginalJson(JSON.stringify(parsed));
  }, [tenant.id]);

  useEffect(() => {
    void loadBranding();
  }, [loadBranding]);

  // Preview en tiempo real — al cambiar el draft, aplicamos los colores al
  // :root para que toda la app se vea con la nueva paleta mientras el admin
  // edita. NO toca DB.
  useEffect(() => {
    applyBranding({
      color_primary: draft.color_primary,
      color_accent: draft.color_accent
    });
  }, [draft.color_primary, draft.color_accent]);

  // Cleanup — si el admin sale de la pantalla SIN guardar, restaurar al
  // estado persistido para que el preview no quede pegado.
  useEffect(() => {
    return () => {
      applyBranding({
        color_primary: persisted.color_primary,
        color_accent: persisted.color_accent
      });
    };
  }, [persisted.color_primary, persisted.color_accent]);

  const dirty = JSON.stringify(draft) !== originalJson;

  function resetColorsToSALA() {
    setDraft((d) => ({
      ...d,
      color_primary: SALA_DEFAULT_PRIMARY,
      color_accent:  SALA_DEFAULT_ACCENT
    }));
  }

  function discardChanges() {
    // Revierte el draft al persistido — el useEffect de preview va a llamar
    // applyBranding(persisted) automáticamente.
    setDraft(persisted);
  }

  async function handleSave() {
    setIsSaving(true);

    // Merge no destructivo con otras keys (hide_powered_by, etc.)
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
    setPersisted(draft);
    // Re-lee el tenant para que el LOGO (que sale de tenant.branding, no de
    // CSS vars) se actualice en toda la app sin recargar la página.
    await refetchTenant();
    toast.success('Marca actualizada. Ya aplica en toda la app.');
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
          allowSvg
          fallbackPreviewUrl="/logo-sala.png"
          previewFit="contain"
          helperText="Preferí SVG: se ve nítido en cualquier pantalla. PNG/WEBP también (mínimo 1024px de ancho para no pixelarse en móviles retina). Máx 2MB."
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
          allowSvg
          fallbackPreviewUrl="/isotipo-sala.png"
          previewFit="contain"
          helperText="Símbolo cuadrado (sin texto). Preferí SVG; si es PNG, fondo transparente y 512×512 mínimo. Aparece en el login y espacios chicos."
        />
        {!draft.isotipo_url && (
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Mientras no subas tu isotipo, se muestra el isotipo de SALA como placeholder.
          </p>
        )}
      </Section>

      <Section
        title="COLORES"
        description="Definí la paleta de tu marca. Cambian botones, links, acentos y atmósfera de toda la app. Los cambios se previsualizan en tiempo real — guardá para persistir, o descartá para volver."
      >
        <ColoresEditor
          primary={draft.color_primary}
          accent={draft.color_accent}
          onPrimaryChange={(c) => {
            if (isValidHex(c)) setDraft({ ...draft, color_primary: c });
          }}
          onAccentChange={(c) => {
            if (isValidHex(c)) setDraft({ ...draft, color_accent: c });
          }}
          onReset={resetColorsToSALA}
        />
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
        {dirty && (
          <button
            type="button"
            onClick={discardChanges}
            disabled={isSaving}
            className="ek-cta ek-cta--secondary"
            style={{ padding: '14px 28px', fontSize: '14px' }}
          >
            Descartar
          </button>
        )}
      </div>

      <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '16px' }}>
        Nota: los colores aplican en tiempo real al toda la app. OG image y favicon
        dinámicos requieren recargar la página para verse — la sincronización en
        tiempo real con &lt;meta&gt; tags llega en sprint posterior.
      </p>
    </div>
  );
}

// ============================================================================
// ColoresEditor — 2 color pickers + preview chip strip + warnings
// ============================================================================

interface ColoresEditorProps {
  primary: string;
  accent: string;
  onPrimaryChange: (hex: string) => void;
  onAccentChange: (hex: string) => void;
  onReset: () => void;
}

function ColoresEditor({
  primary,
  accent,
  onPrimaryChange,
  onAccentChange,
  onReset
}: ColoresEditorProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <ColorPickerRow
        label="COLOR PRIMARIO"
        hint="Marca principal: botones, links activos, focus rings, fondos suaves."
        value={primary}
        onChange={onPrimaryChange}
      />
      <ColorPickerRow
        label="COLOR ACENTO"
        hint="Segundo color: highlights, urgencia, status pocos cupos."
        value={accent}
        onChange={onAccentChange}
      />

      <ChipStripPreview label="Paleta primario" base={primary} kind="primary" />
      <ChipStripPreview label="Paleta acento"    base={accent}  kind="accent"  />

      <RealButtonPreview primary={primary} accent={accent} />

      <button
        type="button"
        onClick={onReset}
        className="ek-cta ek-cta--secondary"
        style={{
          padding: '10px 18px',
          fontSize: '13px',
          alignSelf: 'flex-start'
        }}
      >
        ↺ Restablecer verde SALA
      </button>
    </div>
  );
}

function ColorPickerRow({
  label,
  hint,
  value,
  onChange
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  // Estado local del input de texto. value es el hex commiteado (lo que ve el
  // resto de la app); inputValue es lo que el usuario está tipeando (puede ser
  // inválido temporariamente). Se sincronizan en commit (Enter/blur) o cuando
  // value cambia desde afuera (picker visual, reset).
  const [inputValue, setInputValue] = useState<string>(value);
  const [inputError, setInputError] = useState<boolean>(false);

  // Sync desde el padre → input. Si value cambió externamente (picker/reset) y
  // el input no normaliza al mismo color, reflejarlo. Si el usuario está
  // tipeando algo válido que matchea el value commiteado, no-op (no piso lo
  // que está escribiendo).
  useEffect(() => {
    const inputNormalized = normalizeHex(inputValue);
    if (inputNormalized?.toLowerCase() !== value.toLowerCase()) {
      setInputValue(value);
      setInputError(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function commitInput() {
    const normalized = normalizeHex(inputValue);
    if (normalized) {
      setInputError(false);
      setInputValue(normalized); // normaliza la vista a #RRGGBB uppercase
      if (normalized.toLowerCase() !== value.toLowerCase()) onChange(normalized);
    } else {
      setInputError(true);
      // NO llama onChange — queda el último value válido
    }
  }

  const lum = relativeLuminance(value);
  const textOn = pickTextOn(value);
  const ratio = contrastRatio(value, textOn);

  // Warning fuerte: contraste < 4.5:1 (WCAG AA texto)
  const contrastFails = ratio < 4.5;
  // Warning soft: primario muy claro (L > 0.75)
  const tooLight = lum > 0.75;

  return (
    <div>
      <p
        className="ek-eyebrow ek-eyebrow--mustard"
        style={{ margin: 0, marginBottom: '6px', fontSize: '11px' }}
      >
        {label}
      </p>
      <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '12px' }}>
        {hint}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          aria-label={`${label} (selector visual)`}
          style={{
            width: '56px',
            height: '40px',
            borderRadius: '10px',
            border: '0.5px solid var(--sala-border-strong)',
            cursor: 'pointer',
            padding: 0,
            background: 'transparent'
          }}
        />
        <input
          type="text"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            if (inputError) setInputError(false); // limpiar error mientras corrige
          }}
          onBlur={commitInput}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitInput();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              // Cancelar edición: revertir al último value válido
              setInputValue(value);
              setInputError(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${label} en código hex`}
          aria-invalid={inputError}
          placeholder="#3D6B52"
          style={{
            fontFamily: 'var(--ek-font-mono)',
            fontSize: '14px',
            color: inputError ? 'var(--sala-error)' : 'var(--sala-text-primary)',
            background: 'var(--sala-surface)',
            border: inputError
              ? '1px solid var(--sala-error)'
              : '0.5px solid var(--ek-line)',
            padding: '8px 12px',
            borderRadius: '8px',
            letterSpacing: '0.04em',
            width: '110px',
            outline: 'none',
            textTransform: 'uppercase'
          }}
        />
      </div>
      {inputError && (
        <p
          role="alert"
          style={{
            fontSize: '12px',
            color: 'var(--sala-error)',
            margin: 0,
            marginTop: '8px',
            lineHeight: 1.4
          }}
        >
          Formato hex inválido. Ejemplo: <code style={{ fontFamily: 'var(--ek-font-mono)' }}>#3D6B52</code>
        </p>
      )}
      {contrastFails && (
        <p
          style={{
            fontSize: '12px',
            color: 'var(--sala-error)',
            margin: 0,
            marginTop: '10px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '6px',
            lineHeight: 1.4
          }}
        >
          <AlertTriangle size={14} strokeWidth={2.25} style={{ flexShrink: 0, marginTop: '2px' }} />
          El texto sobre este color puede no leerse bien en tamaños pequeños (contraste {ratio.toFixed(1)}:1 vs el mínimo recomendado 4.5:1). Considerá un tono más oscuro.
        </p>
      )}
      {tooLight && (
        <p
          style={{
            fontSize: '12px',
            color: 'var(--sala-warning)',
            margin: 0,
            marginTop: '8px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '6px',
            lineHeight: 1.4
          }}
        >
          <span aria-hidden="true">💡</span>
          Este color es muy claro — los fondos suaves podrían no diferenciarse bien del fondo de la app.
        </p>
      )}
    </div>
  );
}

function ChipStripPreview({
  label,
  base,
  kind
}: {
  label: string;
  base: string;
  kind: 'primary' | 'accent';
}) {
  // Cada chip muestra UN derivado del color base. Usamos los CSS vars
  // dinámicos para que el chip refleje exactamente lo que verá toda la app.
  // (Los CSS vars ya están seteados por el preview en tiempo real del
  // useEffect del padre.)
  const chips = [
    { name: 'base',      bg: `var(--sala-${kind})` },
    { name: 'hover',     bg: `var(--sala-${kind}-hover)` },
    { name: 'active',    bg: `var(--sala-${kind}-active)` },
    { name: 'light',     bg: `var(--sala-${kind}-light)` },
    { name: 'soft',      bg: `var(--sala-${kind}-soft)` },
    { name: 'dim',       bg: `var(--sala-${kind}-dim)` },
    { name: 'glow',      bg: `var(--sala-${kind}-glow)` },
    { name: 'darkest',   bg: `var(--sala-${kind}-darkest)` }
  ];
  return (
    <div>
      <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '8px' }}>
        {label} <code style={{ fontFamily: 'var(--ek-font-mono)', fontSize: '11px' }}>{base.toUpperCase()}</code>
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {chips.map((c) => (
          <div key={c.name} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '8px',
                background: c.bg,
                border: '0.5px solid var(--ek-line)'
              }}
            />
            <span style={{ fontSize: '10px', color: 'var(--ek-ink-faint)', letterSpacing: '0.04em' }}>
              {c.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RealButtonPreview({ primary, accent }: { primary: string; accent: string }) {
  return (
    <div>
      <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '8px' }}>
        Vista previa real
      </p>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '12px',
          padding: '20px',
          background: 'var(--sala-bg)',
          border: '0.5px solid var(--ek-line)',
          borderRadius: '14px'
        }}
      >
        <button type="button" className="ek-cta" style={{ padding: '10px 18px', fontSize: '13px' }}>
          Botón primario
        </button>
        <button
          type="button"
          className="ek-cta"
          style={{
            padding: '10px 18px',
            fontSize: '13px',
            background: 'var(--sala-accent)',
            borderColor: 'var(--sala-accent)',
            color: 'var(--sala-accent-text)',
            boxShadow: '0 2px 8px var(--sala-accent-shadow)'
          }}
        >
          Botón acento
        </button>
        {/* Texto sobre darkest — vista previa del sidebar/login oscuro */}
        <div
          style={{
            padding: '12px 16px',
            background: 'var(--sala-primary-darkest)',
            color: '#FFFFFF',
            borderRadius: '10px',
            fontSize: '13px',
            fontWeight: 500
          }}
        >
          Texto sobre primary-darkest ({primary.toUpperCase()})
        </div>
        <div
          style={{
            padding: '12px 16px',
            background: 'var(--sala-accent-darkest)',
            color: '#FFFFFF',
            borderRadius: '10px',
            fontSize: '13px',
            fontWeight: 500
          }}
        >
          Texto sobre accent-darkest ({accent.toUpperCase()})
        </div>
      </div>
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
          color: 'var(--sala-text-tertiary)',
          flexShrink: 0
        }}
      >
        {kind === 'image' ? <ImageIcon size={22} /> : <Folder size={22} />}
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
