import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Circle } from 'lucide-react';
import type { GymSetup } from '../hooks/useGymSetup';

interface Paso {
  key: keyof GymSetup;
  esencial: boolean;
  titulo: string;
  desc: string;
  to: string;
  cta: string;
}

const PASOS: Paso[] = [
  { key: 'sala', esencial: true, titulo: 'Crea tu primera sala', desc: 'El espacio donde ocurren las clases.', to: '/admin/recursos', cta: 'Ir a Salas' },
  { key: 'horarios', esencial: true, titulo: 'Armá tu horario semanal', desc: 'Sin horarios no hay clases que reservar.', to: '/admin/horarios', cta: 'Ir a Horarios' },
  { key: 'plan', esencial: true, titulo: 'Pon precio a tus planes', desc: 'Tus planes nacen en $0 — fija cuánto cobras.', to: '/admin/tiers', cta: 'Ir a Planes' },
  { key: 'instructor', esencial: false, titulo: 'Agrega tus instructores', desc: 'Le ponen cara a cada clase. (Opcional)', to: '/admin/instructores', cta: 'Ir a Instructores' },
  { key: 'marca', esencial: false, titulo: 'Sube tu logo y marca', desc: 'Personaliza la experiencia de tus socios. (Opcional)', to: '/admin/marca', cta: 'Ir a Marca' }
];

/** Checklist de activación para gyms nuevos. Se renderiza solo mientras falte
 *  algún paso ESENCIAL (sala/horarios/plan) — un gym ya operativo no lo ve. */
export default function ChecklistActivacion({ setup }: { setup: GymSetup }) {
  const esencialesDone = PASOS.filter((p) => p.esencial && setup[p.key]).length;
  const esencialesTotal = PASOS.filter((p) => p.esencial).length;
  // Primer paso pendiente (esencial primero) → lo destacamos como "siguiente".
  const siguiente =
    PASOS.find((p) => p.esencial && !setup[p.key]) ?? PASOS.find((p) => !setup[p.key]);

  return (
    <section
      className="ek-card"
      style={{ padding: '24px', marginBottom: '32px', borderColor: 'var(--ek-mustard-dim)' }}
    >
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ fontSize: '11px', marginBottom: '2px' }}>
        PRIMEROS PASOS
      </p>
      <h2
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '22px',
          fontWeight: 600,
          letterSpacing: '-0.02em',
          margin: 0,
          marginBottom: '4px'
        }}
      >
        Activa tu estudio
      </h2>
      <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '20px' }}>
        {esencialesDone} de {esencialesTotal} pasos esenciales listos. Completalos para empezar a recibir reservas.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {PASOS.map((p) => {
          const done = setup[p.key];
          const esSiguiente = siguiente?.key === p.key;
          return (
            <div
              key={p.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                padding: '12px 14px',
                borderRadius: '12px',
                background: esSiguiente ? 'var(--ek-mustard-soft)' : 'transparent',
                border: `0.5px solid ${esSiguiente ? 'var(--ek-mustard-dim)' : 'transparent'}`
              }}
            >
              {done ? (
                <CheckCircle2 size={20} strokeWidth={2.25} style={{ color: 'var(--ek-success)', flexShrink: 0 }} />
              ) : (
                <Circle size={20} strokeWidth={2} style={{ color: 'var(--ek-ink-faint)', flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    fontSize: '14px',
                    fontWeight: 600,
                    margin: 0,
                    color: done ? 'var(--ek-ink-muted)' : 'var(--ek-ink)',
                    textDecoration: done ? 'line-through' : 'none'
                  }}
                >
                  {p.titulo}
                </p>
                {!done && (
                  <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0, marginTop: '2px' }}>
                    {p.desc}
                  </p>
                )}
              </div>
              {!done && (
                <Link
                  to={p.to}
                  className={esSiguiente ? 'ek-cta' : 'ek-cta ek-cta--secondary'}
                  style={{
                    flexShrink: 0,
                    padding: '8px 14px',
                    fontSize: '12px',
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px'
                  }}
                >
                  {p.cta}
                  <ArrowRight size={13} strokeWidth={2.5} />
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
