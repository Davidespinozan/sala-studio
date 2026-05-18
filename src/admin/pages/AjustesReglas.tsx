import { useEffect, useState } from 'react';
import { useTenantConfigEditor } from '../hooks/useTenantConfigEditor';
import { useToast } from '@shared/hooks/useToast';
import Toggle from '../components/Toggle';

type ReglasDraft = {
  anticipacion_min_horas: number;
  duracion_default_min: number;
  permitir_continuas: boolean;
  no_show_bloqueo_dias: number;
};

const DEFAULT: ReglasDraft = {
  anticipacion_min_horas: 24,
  duracion_default_min: 60,
  permitir_continuas: false,
  no_show_bloqueo_dias: 7
};

function readDraft(config: Record<string, unknown> | null): ReglasDraft {
  const reserva = (config?.reserva ?? {}) as Record<string, unknown>;
  const penalizaciones = (config?.penalizaciones ?? {}) as Record<string, unknown>;

  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    anticipacion_min_horas: num(reserva.anticipacion_min_horas, DEFAULT.anticipacion_min_horas),
    duracion_default_min: num(reserva.duracion_default_min, DEFAULT.duracion_default_min),
    permitir_continuas: Boolean(reserva.permitir_continuas ?? DEFAULT.permitir_continuas),
    no_show_bloqueo_dias: num(penalizaciones.no_show_bloqueo_dias, DEFAULT.no_show_bloqueo_dias)
  };
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
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="ek-card"
      style={{ padding: '24px', marginBottom: '20px', display: 'block' }}
    >
      <p
        className="ek-eyebrow ek-eyebrow--mustard"
        style={{ marginBottom: '18px', fontSize: '11px' }}
      >
        {title}
      </p>
      {children}
    </section>
  );
}

export default function AjustesReglas() {
  const { config, isLoading, isSaving, saveTopLevel } = useTenantConfigEditor();
  const toast = useToast();
  const [draft, setDraft] = useState<ReglasDraft>(DEFAULT);
  const [originalJson, setOriginalJson] = useState('');

  useEffect(() => {
    if (!config) return;
    const parsed = readDraft(config);
    setDraft(parsed);
    setOriginalJson(JSON.stringify(parsed));
  }, [config]);

  const dirty = JSON.stringify(draft) !== originalJson;

  async function handleSave() {
    if (!Number.isFinite(draft.anticipacion_min_horas) || draft.anticipacion_min_horas < 0) {
      toast.error('Anticipación mínima debe ser un número positivo.');
      return;
    }
    if (!Number.isFinite(draft.duracion_default_min) || draft.duracion_default_min <= 0) {
      toast.error('Duración debe ser mayor a 0.');
      return;
    }

    // Merge no destructivo: solo escribimos los campos consumidos.
    // Los campos DEAD (cupos_por_recurso, etc) se preservan en BD.
    const reserva = (config?.reserva ?? {}) as Record<string, unknown>;
    const penalizaciones = (config?.penalizaciones ?? {}) as Record<string, unknown>;

    const patch = {
      reserva: {
        ...reserva,
        anticipacion_min_horas: draft.anticipacion_min_horas,
        duracion_default_min: draft.duracion_default_min,
        permitir_continuas: draft.permitir_continuas
      },
      penalizaciones: {
        ...penalizaciones,
        no_show_bloqueo_dias: draft.no_show_bloqueo_dias
      }
    };

    const { error } = await saveTopLevel(patch);
    if (error) {
      toast.error(`No se pudo guardar: ${error}`);
      return;
    }
    setOriginalJson(JSON.stringify(draft));
    toast.success('Cambios guardados.');
  }

  function handleDiscard() {
    if (!config) return;
    setDraft(readDraft(config));
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
        Reglas
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '24px' }}>
        Cómo funciona el sistema de reservas para tus miembros.
      </p>

      <Section title="TIEMPO Y ANTICIPACIÓN">
        <FormField
          label="Anticipación mínima (horas)"
          helper="Cuántas horas antes de la sesión debe reservar el miembro. Ejemplo: 24 horas."
        >
          <input
            type="number"
            min={0}
            value={draft.anticipacion_min_horas}
            onChange={(e) =>
              setDraft({ ...draft, anticipacion_min_horas: parseInt(e.target.value) || 0 })
            }
            className="ek-input"
          />
        </FormField>

        <FormField
          label="Duración default de sesión (minutos)"
          helper="Cuánto dura por defecto cada sesión. Ejemplo: 60 (1 hora)."
        >
          <input
            type="number"
            min={1}
            value={draft.duracion_default_min}
            onChange={(e) =>
              setDraft({ ...draft, duracion_default_min: parseInt(e.target.value) || 0 })
            }
            className="ek-input"
          />
        </FormField>

        <div style={{ marginTop: '8px' }}>
          <Toggle
            checked={draft.permitir_continuas}
            onChange={(v) => setDraft({ ...draft, permitir_continuas: v })}
            label="Permitir reservas continuas"
            description="Si está activado, los miembros pueden reservar dos sesiones seguidas. Si está desactivado, debe haber al menos un slot entre reservas del mismo miembro."
          />
        </div>
      </Section>

      <Section title="PENALIZACIONES">
        <FormField
          label="Bloqueo por no llegar a la reserva (días)"
          helper="Días que se bloquea un miembro si no asiste a una sesión reservada. Ejemplo: 7 días."
        >
          <input
            type="number"
            min={0}
            value={draft.no_show_bloqueo_dias}
            onChange={(e) =>
              setDraft({ ...draft, no_show_bloqueo_dias: parseInt(e.target.value) || 0 })
            }
            className="ek-input"
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
