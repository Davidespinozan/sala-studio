import { useState } from 'react';
import { AccionModal } from '@shared/components/AccionModal';
import { MotivoField } from '@shared/components/MotivoField';
import { backendPost } from '@shared/lib/backend';

interface Props {
  socioId: string;
  socioNombre: string;
  modo: 'pausar' | 'reactivar';
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

export function PausarReactivarMembresiaModal({ socioId, socioNombre, modo, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const esPausar = modo === 'pausar';

  const opciones = esPausar
    ? ['Viaje del cliente', 'Lesión / cirugía', 'Solicitud del cliente', 'Pausa administrativa']
    : ['Cliente volvió de viaje', 'Recuperado de lesión', 'Solicitud del cliente'];

  return (
    <AccionModal
      isOpen={isOpen}
      title={esPausar ? 'Pausar membresía' : 'Reactivar membresía'}
      description={
        esPausar
          ? `Pausas la membresía de ${socioNombre}. No podrá reservar hasta reactivarla.`
          : `Reactivas la membresía de ${socioNombre}.`
      }
      variant={esPausar ? 'warning' : 'info'}
      confirmLabel={esPausar ? 'Pausar' : 'Reactivar'}
      canConfirm={motivo.trim().length > 0}
      onConfirm={async () => {
        // Pasa por la función (pausa/reanuda también la suscripción de Stripe).
        await backendPost('pausar-membresia', {
          usuario_id: socioId,
          modo,
          motivo: motivo.trim()
        });
        await onDone();
      }}
      onClose={onClose}
    >
      <MotivoField
        value={motivo}
        onChange={setMotivo}
        opciones={opciones}
        label={esPausar ? 'Motivo de la pausa' : 'Motivo de la reactivación'}
      />
    </AccionModal>
  );
}
