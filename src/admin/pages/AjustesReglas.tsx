import { useEffect, useState } from 'react';
import { useTenantConfigEditor } from '../hooks/useTenantConfigEditor';
import { useToast } from '@shared/hooks/useToast';
import { DEFAULT_TIMEZONE, TIMEZONE_OPTIONS } from '@shared/lib/timezone';
import Toggle from '../components/Toggle';

type ReglasDraft = {
  anticipacion_min_minutos: number;
  duracion_default_min: number;
  permitir_continuas: boolean;
  cancelacion_min_horas: number;
  no_show_bloqueo_dias: number;
  multa_rereserva_activa: boolean;
  multa_rereserva_pesos: number;
  multa_inasistencia_activa: boolean;
  multa_inasistencia_pesos: number;
  timezone: string;
};

/**
 * Tienen que coincidir con los defaults de los RPCs, o la pantalla le miente al
 * dueño sobre lo que su gym está haciendo.
 *
 * Los dos primeros eran 24 horas y 7 días, y castigaban al gym que no tocaba
 * nada: no dejaban reservar la clase de mañana, y bloqueaban una semana a socios
 * que sí habían ido pero a los que nadie les hizo check-in. Un default es lo que
 * el sistema decide por vos cuando no dijiste nada — y decidía en contra.
 */
const DEFAULT: ReglasDraft = {
  anticipacion_min_minutos: 0, // sin umbral: se reserva hasta que arranca la clase
  duracion_default_min: 60,
  permitir_continuas: false,
  cancelacion_min_horas: 4, // debe coincidir con el default del RPC cancelar_reserva_atomic
  no_show_bloqueo_dias: 0, // registrar la falta, no castigar. Castigar se elige.
  multa_rereserva_activa: false, // Modelo A apagado por default: nada cambia.
  multa_rereserva_pesos: 75,
  multa_inasistencia_activa: false, // Modelo B apagado por default.
  multa_inasistencia_pesos: 75,
  timezone: DEFAULT_TIMEZONE
};

function readDraft(config: Record<string, unknown> | null): ReglasDraft {
  const reserva = (config?.reserva ?? {}) as Record<string, unknown>;
  const penalizaciones = (config?.penalizaciones ?? {}) as Record<string, unknown>;

  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    // Lee minutos; si el gym solo tenía la vieja en horas, la convierte ×60.
    anticipacion_min_minutos: num(
      reserva.anticipacion_min_minutos,
      reserva.anticipacion_min_horas != null
        ? num(reserva.anticipacion_min_horas, 0) * 60
        : DEFAULT.anticipacion_min_minutos
    ),
    duracion_default_min: num(reserva.duracion_default_min, DEFAULT.duracion_default_min),
    permitir_continuas: Boolean(reserva.permitir_continuas ?? DEFAULT.permitir_continuas),
    cancelacion_min_horas: num(reserva.cancelacion_min_horas, DEFAULT.cancelacion_min_horas),
    no_show_bloqueo_dias: num(penalizaciones.no_show_bloqueo_dias, DEFAULT.no_show_bloqueo_dias),
    multa_rereserva_activa: Boolean(penalizaciones.multa_rereserva_activa ?? DEFAULT.multa_rereserva_activa),
    multa_rereserva_pesos: Math.round(
      num(penalizaciones.multa_rereserva_centavos, DEFAULT.multa_rereserva_pesos * 100) / 100
    ),
    multa_inasistencia_activa: Boolean(penalizaciones.multa_inasistencia_activa ?? DEFAULT.multa_inasistencia_activa),
    multa_inasistencia_pesos: Math.round(
      num(penalizaciones.multa_inasistencia_centavos, DEFAULT.multa_inasistencia_pesos * 100) / 100
    ),
    timezone:
      typeof config?.timezone === 'string' && config.timezone
        ? (config.timezone as string)
        : DEFAULT_TIMEZONE
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
    if (!Number.isFinite(draft.anticipacion_min_minutos) || draft.anticipacion_min_minutos < 0) {
      toast.error('Anticipación mínima debe ser un número positivo.');
      return;
    }
    if (!Number.isFinite(draft.duracion_default_min) || draft.duracion_default_min <= 0) {
      toast.error('Duración debe ser mayor a 0.');
      return;
    }
    if (!Number.isFinite(draft.cancelacion_min_horas) || draft.cancelacion_min_horas < 0) {
      toast.error('La ventana de cancelación debe ser un número positivo.');
      return;
    }
    if (!Number.isFinite(draft.no_show_bloqueo_dias) || draft.no_show_bloqueo_dias < 0) {
      toast.error('El bloqueo por inasistencia no puede ser negativo.');
      return;
    }
    if (!Number.isFinite(draft.multa_rereserva_pesos) || draft.multa_rereserva_pesos < 0) {
      toast.error('La multa por re-reservar no puede ser negativa.');
      return;
    }
    if (!Number.isFinite(draft.multa_inasistencia_pesos) || draft.multa_inasistencia_pesos < 0) {
      toast.error('La multa por faltar no puede ser negativa.');
      return;
    }

    // Merge no destructivo: solo escribimos los campos consumidos.
    // Los campos DEAD (cupos_por_recurso, etc) se preservan en BD.
    const reserva = (config?.reserva ?? {}) as Record<string, unknown>;
    const penalizaciones = (config?.penalizaciones ?? {}) as Record<string, unknown>;

    const patch = {
      reserva: {
        ...reserva,
        anticipacion_min_minutos: draft.anticipacion_min_minutos,
        duracion_default_min: draft.duracion_default_min,
        permitir_continuas: draft.permitir_continuas,
        cancelacion_min_horas: draft.cancelacion_min_horas
      },
      penalizaciones: {
        ...penalizaciones,
        no_show_bloqueo_dias: draft.no_show_bloqueo_dias,
        multa_rereserva_activa: draft.multa_rereserva_activa,
        multa_rereserva_centavos: Math.round(draft.multa_rereserva_pesos * 100),
        multa_inasistencia_activa: draft.multa_inasistencia_activa,
        multa_inasistencia_centavos: Math.round(draft.multa_inasistencia_pesos * 100)
      },
      timezone: draft.timezone
    };

    const { error } = await saveTopLevel(patch);
    if (error) {
      toast.error('No pudimos guardar las reglas. Prueba de nuevo.');
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
          label="Anticipación mínima (minutos)"
          helper="Cuántos minutos antes de la sesión debe reservar el miembro. Ejemplo: 15. Pon 0 para permitir reservar hasta el último momento."
        >
          <input
            type="number"
            min={0}
            value={draft.anticipacion_min_minutos}
            onChange={(e) =>
              setDraft({ ...draft, anticipacion_min_minutos: parseInt(e.target.value) || 0 })
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

      <Section title="CANCELACIONES">
        <FormField
          label="Ventana de cancelación (horas antes)"
          helper="Hasta cuántas horas antes de la clase el miembro puede cancelar sin castigo. Si cancela más tarde —o falta—, esa clase cuenta como consumida: en planes de créditos pierde el crédito, y en TODOS los planes (incluida mensualidad) usa su cupo del día, así que para volver a reservar ese día deberá pagar la multa (si está activada abajo)."
        >
          <input
            type="number"
            min={0}
            value={draft.cancelacion_min_horas}
            onChange={(e) =>
              setDraft({ ...draft, cancelacion_min_horas: parseInt(e.target.value) || 0 })
            }
            className="ek-input"
          />
        </FormField>
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

        <div style={{ marginTop: '8px', marginBottom: '14px' }}>
          <Toggle
            checked={draft.multa_rereserva_activa}
            onChange={(v) => setDraft({ ...draft, multa_rereserva_activa: v })}
            label="Multa por reservar de nuevo tras faltar"
            description="Si un miembro falta a su clase (sin cancelarla) y quiere reservar otra el mismo día, se le permite pagando una multa que se cobra en recepción. Apagado: no puede reservar de nuevo ese día."
          />
        </div>

        {draft.multa_rereserva_activa && (
          <FormField
            label="Monto de la multa (pesos)"
            helper="Lo que paga el miembro en recepción por reservar otra clase el mismo día tras faltar. Ejemplo: 75."
          >
            <input
              type="number"
              min={0}
              value={draft.multa_rereserva_pesos}
              onChange={(e) =>
                setDraft({ ...draft, multa_rereserva_pesos: parseInt(e.target.value) || 0 })
              }
              className="ek-input"
            />
          </FormField>
        )}

        <div style={{ marginTop: '8px', marginBottom: '14px' }}>
          <Toggle
            checked={draft.multa_inasistencia_activa}
            onChange={(v) => setDraft({ ...draft, multa_inasistencia_activa: v })}
            label="Multa automática por faltar"
            description="Cobra una multa cuando el miembro no asiste a una reserva que no canceló, aunque no vuelva a reservar. Se cobra en recepción la próxima vez que llegue. Es independiente de la multa por re-reservar."
          />
        </div>

        {draft.multa_inasistencia_activa && (
          <FormField
            label="Monto de la multa por faltar (pesos)"
            helper="Lo que se le cobra al miembro por no asistir sin cancelar. Ejemplo: 75."
          >
            <input
              type="number"
              min={0}
              value={draft.multa_inasistencia_pesos}
              onChange={(e) =>
                setDraft({ ...draft, multa_inasistencia_pesos: parseInt(e.target.value) || 0 })
              }
              className="ek-input"
            />
          </FormField>
        )}
      </Section>

      <Section title="ZONA HORARIA">
        <FormField
          label="Zona horaria del gimnasio"
          helper="Todas las clases y reservas se manejan en esta zona horaria. Cambiarla no afecta las clases ya creadas — solo las que se generen después."
        >
          <select
            value={draft.timezone}
            onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
            className="ek-input"
          >
            {TIMEZONE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
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
