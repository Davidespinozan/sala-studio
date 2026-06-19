import { useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useLugaresSala } from '@member/hooks/useLugaresSala';
import { useInscritosDeClase } from '@admin/hooks/useInscritosDeClase';
import { ICONO_EMOJI } from '@shared/lib/salaLayout';
import type { ReservaConJoin } from '../../hooks/useReservasHoy';

/**
 * Mapa de Salón interactivo para recepción: ve quién va en cada lugar y puede
 * MOVER a un socio. Flujo: tocas a la persona a mover (queda resaltada), después
 * tocas un lugar libre. Reasigna vía RPC cambiar_lugar_reserva (staff-gated).
 */
export function MapaClaseModal({
  reserva,
  onClose
}: {
  reserva: ReservaConJoin;
  onClose: () => void;
}) {
  const recursoId = reserva.recurso_id;
  const claseId = (reserva as { clase_id?: string | null }).clase_id ?? null;
  const { layout } = useLugaresSala(recursoId, claseId);
  const { inscritos, refetch } = useInscritosDeClase(claseId);

  // Por defecto, preseleccionamos a la persona que abrió el modal.
  const [moviendo, setMoviendo] = useState<string | null>(reserva.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activos = inscritos.filter((i) => i.status === 'confirmada' || i.status === 'completada');
  const porLugar = new Map<string, { reservaId: string; nombre: string }>();
  for (const i of activos) {
    if (i.lugarId) porLugar.set(i.lugarId, { reservaId: i.reservaId, nombre: i.nombre });
  }

  async function mover(lugarId: string) {
    if (!moviendo || busy) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc(
      'cambiar_lugar_reserva' as never,
      { p_reserva_id: moviendo, p_lugar_id: lugarId } as never
    );
    if (err) {
      setError((err as { message: string }).message);
      setBusy(false);
      return;
    }
    await refetch();
    setMoviendo(null);
    setBusy(false);
  }

  const emoji = layout ? ICONO_EMOJI[layout.tipo_icono] : '◼️';
  const nombreMoviendo = moviendo
    ? activos.find((i) => i.reservaId === moviendo)?.nombre ?? 'el socio'
    : null;

  return (
    <div className="rec-modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="rec-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '460px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard">MAPA DE LA CLASE</p>
        <h3 style={{ color: 'var(--ek-ink)', fontFamily: 'var(--ek-font-display)', fontSize: '1.35rem', fontWeight: 700, letterSpacing: '-0.02em', margin: '0.25rem 0 0.15rem' }}>
          {reserva.recurso?.nombre}
        </h3>
        <p style={{ color: 'var(--ek-ink-muted)', margin: 0, fontSize: '13px' }}>
          {moviendo
            ? `Moviendo a ${nombreMoviendo}: toca un lugar libre.`
            : 'Toca a una persona para moverla.'}
        </p>

        {!layout ? (
          <p style={{ color: 'var(--ek-ink-muted)', marginTop: '1rem' }}>Esta sala no usa Mapa de Salón.</p>
        ) : (
          <>
            <div style={{ textAlign: 'center', fontSize: '10px', fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--sala-text-tertiary)', background: 'var(--sala-bg)', borderRadius: '8px', padding: '6px', margin: '14px 0 8px' }}>
              ▲ Frente
            </div>
            <div style={{ display: 'grid', gap: '6px', gridTemplateColumns: `repeat(${layout.cols}, 1fr)` }}>
              {Array.from({ length: layout.rows }).flatMap((_, y) =>
                Array.from({ length: layout.cols }).map((__, x) => {
                  const lugar = layout.lugares.find((l) => l.x === x && l.y === y);
                  if (!lugar) return <div key={`${x}-${y}`} aria-hidden="true" />;
                  const ocup = porLugar.get(lugar.id);
                  const esMoviendo = !!ocup && ocup.reservaId === moviendo;
                  const onClick = () => {
                    if (busy) return;
                    if (ocup) setMoviendo(ocup.reservaId);
                    else if (moviendo) void mover(lugar.id);
                  };
                  return (
                    <button
                      key={`${x}-${y}`}
                      type="button"
                      disabled={busy}
                      onClick={onClick}
                      title={ocup ? ocup.nombre : `Lugar ${lugar.label} libre`}
                      style={{
                        aspectRatio: '1', display: 'flex', flexDirection: 'column', alignItems: 'center',
                        justifyContent: 'center', borderRadius: '9px', overflow: 'hidden', padding: '2px',
                        fontSize: '9.5px', fontWeight: 700, lineHeight: 1.1, textAlign: 'center', fontFamily: 'inherit',
                        cursor: busy ? 'wait' : 'pointer',
                        border: esMoviendo ? '2px solid var(--sala-primary)' : ocup ? '1px solid var(--sala-primary)' : '1px dashed var(--sala-border)',
                        background: esMoviendo ? 'var(--sala-primary)' : ocup ? 'color-mix(in srgb, var(--sala-primary) 12%, var(--sala-surface))' : 'transparent',
                        color: esMoviendo ? 'var(--sala-primary-text)' : ocup ? 'var(--sala-primary)' : 'var(--sala-text-tertiary)'
                      }}
                    >
                      {ocup ? (
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%', whiteSpace: 'nowrap' }}>
                          {ocup.nombre.trim().split(/\s+/)[0]}
                        </span>
                      ) : (
                        <>
                          <span style={{ fontSize: '13px', opacity: 0.5 }}>{emoji}</span>
                          <span style={{ opacity: 0.6 }}>{lugar.label}</span>
                        </>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {error && <p style={{ color: 'var(--ek-danger)', fontSize: '12px', marginTop: '10px' }}>{error}</p>}
          </>
        )}

        <button onClick={onClose} className="ek-cta ek-cta--full" style={{ marginTop: '1.25rem' }}>
          Listo
        </button>
      </div>
    </div>
  );
}
