import { useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import { formatHora } from '@member/logic/reservaLogic';

export interface ReservaListItem {
  id: string;
  slot_inicio: string;
  recurso_nombre: string;
  status: string;
}

interface Props {
  reservas: ReservaListItem[];
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

export function MiembroProximasReservas({ reservas, onAfterCancel }: Props) {
  const toast = useToast();
  const [cancelandoId, setCancelandoId] = useState<string | null>(null);

  async function handleCancelar(r: ReservaListItem) {
    if (!confirm(`Cancelar la reserva de ${formatFecha(r.slot_inicio)} a las ${formatHora(new Date(r.slot_inicio))}?\nEsto libera el cupo.`)) return;
    setCancelandoId(r.id);
    const { error } = await supabase
      .from('reservas')
      .update({
        status: 'cancelada_admin',
        cancelada_at: new Date().toISOString(),
        cancelada_motivo: 'Cancelada por admin desde ficha del miembro.'
      } as never)
      .eq('id', r.id);
    setCancelandoId(null);
    if (error) {
      toast.error('No pudimos cancelar la reserva. Probá de nuevo.');
      return;
    }
    toast.success('Reserva cancelada.');
    await onAfterCancel();
  }

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
            onClick={() => handleCancelar(r)}
            disabled={cancelandoId === r.id}
            style={{
              padding: '6px 14px',
              minHeight: '32px',
              background: 'transparent',
              color: 'var(--sala-accent)',
              border: '1px solid var(--sala-accent)',
              borderRadius: '999px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: cancelandoId === r.id ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              opacity: cancelandoId === r.id ? 0.6 : 1
            }}
          >
            {cancelandoId === r.id ? '…' : 'Cancelar'}
          </button>
        </div>
      ))}
    </div>
  );
}
