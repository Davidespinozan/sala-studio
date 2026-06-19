import { useState } from 'react';
import { AccionModal } from '@shared/components/AccionModal';
import { MotivoField } from '@shared/components/MotivoField';
import { useAccionRecepcion } from '../../hooks/useAccionRecepcion';

interface Props {
  reservaId: string;
  reservaLabel: string;
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

export function CancelarReservaModal({ reservaId, reservaLabel, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_cancelar_reserva' });

  return (
    <AccionModal
      isOpen={isOpen}
      title="Cancelar reserva"
      description={`Cancelas la reserva de ${reservaLabel}. Si corresponde, se le devuelve el crédito.`}
      variant="danger"
      confirmLabel="Cancelar reserva"
      cancelLabel="Volver"
      canConfirm={motivo.trim().length > 0}
      onConfirm={async () => {
        await ejecutar({ p_reserva_id: reservaId, p_motivo: motivo });
        await onDone();
      }}
      onClose={onClose}
    >
      <MotivoField
        value={motivo}
        onChange={setMotivo}
        opciones={['Cliente avisó que no viene', 'Error de carga', 'Doble reserva', 'Clase cancelada']}
        label="Motivo"
      />
    </AccionModal>
  );
}
