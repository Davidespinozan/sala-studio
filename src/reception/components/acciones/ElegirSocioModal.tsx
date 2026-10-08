import { useState } from 'react';
import { Search } from 'lucide-react';
import { Avatar } from '@shared/components/Avatar';
import { useSocios, type SocioListItem } from '../../hooks/useSocios';

/**
 * Paso 1 de "+ Agregar socio" desde la Agenda: buscar a quién inscribir. Al
 * elegirlo se abre CrearReservaModal con la clase ya puesta (todas las reglas de
 * reserva —plan, cupo, day pass, recargo, lugar— viven ahí, no aquí).
 */
export function ElegirSocioModal({
  titulo,
  onElegir,
  onClose
}: {
  /** Ej. "Yoga · Hoy 7:00". */
  titulo: string;
  onElegir: (socio: SocioListItem) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const { socios, isLoading } = useSocios(q);
  // Sin búsqueda no listamos a todos: se pide escribir (padrones de cientos).
  const resultados = q.trim().length >= 2 ? socios.slice(0, 8) : [];

  return (
    <div className="ek-modal-backdrop" onClick={onClose}>
      <div className="ek-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <h3 className="ek-h3" style={{ marginBottom: '2px' }}>Agregar socio</h3>
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '0 0 14px' }}>{titulo}</p>

        <div style={{ position: 'relative', marginBottom: '12px' }}>
          <Search size={17} style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: 'var(--sala-text-tertiary)', pointerEvents: 'none' }} />
          <input
            type="text"
            className="ek-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Nombre o teléfono…"
            autoFocus
            style={{ paddingLeft: '40px', width: '100%', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minHeight: '60px' }}>
          {q.trim().length < 2 ? (
            <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', margin: '8px 2px' }}>
              Escribe al menos 2 letras del nombre o el teléfono.
            </p>
          ) : isLoading ? (
            <div className="ek-skeleton" style={{ height: '52px', borderRadius: '12px' }} />
          ) : resultados.length === 0 ? (
            <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', margin: '8px 2px' }}>
              Nadie coincide. Si es nuevo, dalo de alta en Socios.
            </p>
          ) : (
            resultados.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onElegir(s)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '12px', width: '100%', textAlign: 'left',
                  padding: '10px 12px', borderRadius: '12px', cursor: 'pointer', fontFamily: 'inherit',
                  background: 'var(--sala-surface)', border: '1px solid var(--sala-border)'
                }}
              >
                <Avatar src={s.avatar_url} nombre={s.nombre} size={34} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--sala-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.nombre ?? s.email}
                  </p>
                  <p style={{ margin: '1px 0 0', fontSize: '12px', color: 'var(--sala-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {[s.membresia_tier, s.telefono ?? s.email].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>

        <button type="button" onClick={onClose} className="ek-cta ek-cta--secondary" style={{ width: '100%', marginTop: '14px' }}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
