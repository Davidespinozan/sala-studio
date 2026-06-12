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

export function CorregirCheckinModal({ reservaId, reservaLabel, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_corregir_checkin' });

  return (
    <AccionModal
      isOpen={isOpen}
      title="Corregir check-in"
      description={`Revertís el check-in de ${reservaLabel}. La reserva vuelve a "confirmada".`}
      variant="warning"
      confirmLabel="Revertir check-in"
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
        opciones={['Check-in por error', 'Se equivocó de clase', 'Anulación administrativa']}
        label="Motivo del cambio"
      />
    </AccionModal>
  );
}
