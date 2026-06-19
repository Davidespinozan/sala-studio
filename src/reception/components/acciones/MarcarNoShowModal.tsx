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

export function MarcarNoShowModal({ reservaId, reservaLabel, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_marcar_no_show' });

  return (
    <AccionModal
      isOpen={isOpen}
      title="Marcar no-show"
      description={`Marcas como inasistencia la reserva de ${reservaLabel}. Queda registrada, baja su % de asistencia y no se devuelve el crédito.`}
      variant="warning"
      confirmLabel="Marcar no-show"
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
        opciones={['No se presentó', 'Llegó fuera de tolerancia', 'Avisó demasiado tarde']}
        label="Motivo"
      />
    </AccionModal>
  );
}
