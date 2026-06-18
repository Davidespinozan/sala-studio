import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Trash2, Check } from 'lucide-react';
import { updateRecursoLayout } from '@admin/hooks/useAdminData';
import {
  type SalaLayout,
  type IconoSala,
  type LugarLayout,
  ICONO_LABEL,
  ICONO_EMOJI,
  GRID_MAX,
  PRESETS,
  renumerar
} from '@shared/lib/salaLayout';

/**
 * Builder del Mapa de Salón. El admin elige una plantilla por disciplina y la
 * ajusta tocando el grid: tap en celda vacía → agrega lugar; tap en lugar →
 * lo quita (se renumeran solos). Guardar sincroniza el cupo de la sala con la
 * cantidad de lugares. "Quitar mapa" vuelve la sala a cupo por conteo.
 */
export function MapaBuilderModal({
  recursoId,
  recursoNombre,
  layoutActual,
  onClose,
  onSaved
}: {
  recursoId: string;
  recursoNombre: string;
  layoutActual: SalaLayout | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [layout, setLayout] = useState<SalaLayout | null>(layoutActual);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lugaresEn = (x: number, y: number) => layout?.lugares.find((l) => l.x === x && l.y === y);

  const toggleCelda = (x: number, y: number) => {
    if (!layout) return;
    const existente = lugaresEn(x, y);
    const base = existente
      ? layout.lugares.filter((l) => l.id !== existente.id)
      : [...layout.lugares, { id: `tmp-${x}-${y}`, label: '', x, y } as LugarLayout];
    setLayout({ ...layout, lugares: renumerar(base) });
  };

  const setIcono = (tipo_icono: IconoSala) => layout && setLayout({ ...layout, tipo_icono });

  const setGrid = (cols: number, rows: number) => {
    if (!layout) return;
    const c = Math.max(1, Math.min(GRID_MAX, cols));
    const r = Math.max(1, Math.min(GRID_MAX, rows));
    // Descartar lugares que queden fuera del nuevo grid.
    const lugares = renumerar(layout.lugares.filter((l) => l.x < c && l.y < r));
    setLayout({ ...layout, cols: c, rows: r, lugares });
  };

  const guardar = async () => {
    if (!layout || layout.lugares.length === 0) {
      setError('Agregá al menos un lugar (o cancelá).');
      return;
    }
    setGuardando(true);
    const { error: err } = await updateRecursoLayout(recursoId, layout);
    if (err) {
      setError(err);
      setGuardando(false);
      return;
    }
    onSaved();
  };

  const quitarMapa = async () => {
    setGuardando(true);
    const { error: err } = await updateRecursoLayout(recursoId, null);
    if (err) {
      setError(err);
      setGuardando(false);
      return;
    }
    onSaved();
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Mapa de ${recursoNombre}`}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(10,15,12,0.55)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: 'max(40px, 6vh) 16px 16px', overflowY: 'auto'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: '560px', background: 'var(--sala-surface)',
          borderRadius: '16px', boxShadow: '0 24px 60px rgba(10,15,12,0.32)', overflow: 'hidden'
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px 6px' }}>
          <div>
            <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '17px', fontWeight: 700, margin: 0, color: 'var(--sala-text-primary)' }}>
              Mapa de {recursoNombre}
            </p>
            <p style={{ fontSize: '12.5px', color: 'var(--sala-text-tertiary)', margin: '2px 0 0' }}>
              {layout ? `${layout.lugares.length} lugar(es) · tocá para agregar/quitar` : 'Elegí una plantilla para empezar'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar"
            style={{ display: 'inline-flex', padding: '6px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--sala-text-tertiary)' }}>
            <X size={18} strokeWidth={2.25} />
          </button>
        </div>

        <div style={{ padding: '8px 18px 18px' }}>
          {!layout ? (
            // Chooser de plantilla
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
              {PRESETS.map((p) => (
                <button key={p.id} type="button" onClick={() => setLayout(p.build())}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '13px 15px', borderRadius: '11px', border: '1px solid var(--sala-border)',
                    background: 'var(--sala-bg)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit'
                  }}>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--sala-text-primary)' }}>{p.nombre}</span>
                  <span style={{ fontSize: '13px', color: 'var(--sala-primary)', fontWeight: 600 }}>Usar →</span>
                </button>
              ))}
            </div>
          ) : (
            <>
              {/* Ícono + tamaño */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
                {(Object.keys(ICONO_LABEL) as IconoSala[]).map((ic) => (
                  <button key={ic} type="button" onClick={() => setIcono(ic)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '5px 11px',
                      borderRadius: '999px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                      border: `1px solid ${layout.tipo_icono === ic ? 'var(--sala-primary)' : 'var(--sala-border)'}`,
                      background: layout.tipo_icono === ic ? 'var(--sala-primary-light)' : 'var(--sala-bg)',
                      color: layout.tipo_icono === ic ? 'var(--sala-primary)' : 'var(--sala-text-secondary)'
                    }}>
                    {ICONO_EMOJI[ic]} {ICONO_LABEL[ic]}
                  </button>
                ))}
                <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--sala-text-tertiary)' }}>
                  <GridStep label="Cols" value={layout.cols} onChange={(v) => setGrid(v, layout.rows)} />
                  <GridStep label="Filas" value={layout.rows} onChange={(v) => setGrid(layout.cols, v)} />
                </span>
              </div>

              {/* FRENTE / COACH */}
              <div style={{ textAlign: 'center', fontSize: '10px', fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--sala-text-tertiary)', background: 'var(--sala-bg)', borderRadius: '8px', padding: '6px', marginBottom: '8px' }}>
                ▲ Frente / Coach
              </div>

              {/* Grid */}
              <div style={{
                display: 'grid', gap: '6px',
                gridTemplateColumns: `repeat(${layout.cols}, 1fr)`
              }}>
                {Array.from({ length: layout.rows }).flatMap((_, y) =>
                  Array.from({ length: layout.cols }).map((__, x) => {
                    const lugar = lugaresEn(x, y);
                    return (
                      <button key={`${x}-${y}`} type="button" onClick={() => toggleCelda(x, y)}
                        aria-label={lugar ? `Quitar lugar ${lugar.label}` : `Agregar lugar en ${x},${y}`}
                        style={{
                          aspectRatio: '1', display: 'flex', flexDirection: 'column', alignItems: 'center',
                          justifyContent: 'center', borderRadius: '9px', cursor: 'pointer', fontFamily: 'inherit',
                          border: lugar ? '1px solid var(--sala-primary)' : '1px dashed var(--sala-border)',
                          background: lugar ? 'var(--sala-primary-light)' : 'transparent',
                          color: lugar ? 'var(--sala-primary)' : 'var(--sala-text-tertiary)',
                          fontSize: layout.cols > 8 ? '11px' : '13px', fontWeight: 700, lineHeight: 1
                        }}>
                        {lugar ? (
                          <>
                            <span style={{ fontSize: layout.cols > 8 ? '13px' : '16px' }}>{ICONO_EMOJI[layout.tipo_icono]}</span>
                            <span>{lugar.label}</span>
                          </>
                        ) : (
                          <span style={{ opacity: 0.4 }}>+</span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>

              {error && <p style={{ fontSize: '12px', color: 'var(--sala-error)', margin: '10px 2px 0' }}>{error}</p>}

              {/* Acciones */}
              <div style={{ display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap' }}>
                <button type="button" onClick={guardar} disabled={guardando}
                  className="ek-cta" style={{ flex: 1, minWidth: '120px', opacity: guardando ? 0.6 : 1 }}>
                  <Check size={16} strokeWidth={2.5} /> {guardando ? 'Guardando…' : 'Guardar mapa'}
                </button>
                {layoutActual && (
                  <button type="button" onClick={quitarMapa} disabled={guardando}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '0 14px',
                      borderRadius: '999px', border: '1px solid var(--sala-border)', background: 'transparent',
                      color: 'var(--sala-text-secondary)', fontWeight: 600, fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit'
                    }}>
                    <Trash2 size={15} strokeWidth={2.25} /> Quitar mapa
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function GridStep({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
      {label}
      <button type="button" onClick={() => onChange(value - 1)} aria-label={`${label} menos`}
        style={stepBtn}>−</button>
      <span style={{ minWidth: '14px', textAlign: 'center', fontWeight: 700, color: 'var(--sala-text-secondary)' }}>{value}</span>
      <button type="button" onClick={() => onChange(value + 1)} aria-label={`${label} más`}
        style={stepBtn}>+</button>
    </span>
  );
}

const stepBtn: React.CSSProperties = {
  width: '20px', height: '20px', borderRadius: '6px', border: '1px solid var(--sala-border)',
  background: 'var(--sala-bg)', cursor: 'pointer', fontWeight: 700, lineHeight: 1,
  color: 'var(--sala-text-secondary)', fontFamily: 'inherit'
};
