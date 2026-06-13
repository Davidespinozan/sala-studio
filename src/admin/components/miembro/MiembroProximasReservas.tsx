import { useState } from 'react';
import { formatHora } from '@member/logic/reservaLogic';
import CancelarReservaModal, { type ReservaParaCancelar } from '../CancelarReservaModal';

export interface ReservaListItem {
  id: string;
  slot_inicio: string;
  recurso_nombre: string;
  status: string;
}

interface Props {
  reservas: ReservaListItem[];
  /** Nombre del socio dueño de las reservas (para el modal de cancelación). */
  usuarioNombre: string;
  onAfterCancel: () => Promise<void>;
}

function formatFecha(iso: string): string {
  const d = new Date(iso);
  const txt = d.toLocaleDateString('es-MX', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });
  return txt.charAt(0).toUpperCase() + txt.slice(1).replace(/\.$/, '');
}

export function MiembroProximasReservas({ reservas, usuarioNombre, onAfterCancel }: Props) {
  // Cancelación vía el modal compartido (motivo + aviso + WhatsApp), que llama
  // al RPC cancelar_reserva_admin → DEVUELVE el crédito y notifica. Antes esto
  // hacía un UPDATE directo que quemaba el crédito del socio.
  const [cancelar, setCancelar] = useState<ReservaParaCancelar | null>(null);

  if (reservas.length === 0) {
    return (
      <div
        style={{
          padding: '24px',
          textAlign: 'center',
          background: 'var(--sala-surface)',
          border: '1px dashed var(--sala-border-strong)',
          borderRadius: '14px'
        }}
      >
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0 }}>
          Sin reservas futuras.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {reservas.map((r) => (
        <div
          key={r.id}
          style={{
            display: 'grid',
            gridTemplateColumns: '92px 1fr auto',
            gap: '14px',
            alignItems: 'center',
            padding: '12px 14px',
            background: 'var(--sala-surface)',
            border: '1px solid var(--sala-border)',
            borderLeft: '3px solid var(--sala-primary)',
            borderRadius: '12px'
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span
              style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '14px',
                fontWeight: 600,
                color: 'var(--sala-text-primary)',
                letterSpacing: '-0.01em'
              }}
            >
              {formatFecha(r.slot_inicio)}
            </span>
            <span
              style={{
                fontSize: '13px',
                color: 'var(--sala-text-secondary)',
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {formatHora(new Date(r.slot_inicio))}
            </span>
          </div>
          <div style={{ minWidth: 0 }}>
            <p
              style={{
                fontSize: '14px',
                fontWeight: 600,
                color: 'var(--sala-text-primary)',
                margin: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {r.recurso_nombre}
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              setCancelar({
                id: r.id,
                slot_inicio: r.slot_inicio,
                recurso_nombre: r.recurso_nombre,
                usuario_nombre: usuarioNombre
              })
            }
            style={{
              padding: '6px 14px',
              minHeight: '32px',
              background: 'transparent',
              color: 'var(--sala-accent)',
              border: '1px solid var(--sala-accent)',
              borderRadius: '999px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit'
            }}
          >
            Cancelar
          </button>
        </div>
      ))}
      {cancelar && (
        <CancelarReservaModal
          reserva={cancelar}
          onClose={() => setCancelar(null)}
          onCancelled={() => { void onAfterCancel(); }}
        />
      )}
    </div>
  );
}
