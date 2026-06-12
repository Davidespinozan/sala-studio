import { useState } from 'react';
import { AccionModal } from '@shared/components/AccionModal';
import { MotivoField } from '@shared/components/MotivoField';
import { useAccionRecepcion } from '../../hooks/useAccionRecepcion';

interface Props {
  socioId: string;
  socioNombre: string;
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

export function CancelarMembresiaModal({ socioId, socioNombre, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_cancelar_membresia' });

  return (
    <AccionModal
      isOpen={isOpen}
      title="Cancelar membresía"
      description={`Cancelás la membresía de ${socioNombre}. Queda registrada como cancelada y deja de poder reservar.`}
      variant="danger"
      confirmLabel="Cancelar membresía"
      cancelLabel="Volver"
      requireTypedConfirmation="CANCELAR"
      canConfirm={motivo.trim().length > 0}
      onConfirm={async () => {
        await ejecutar({ p_usuario_id: socioId, p_motivo: motivo });
        await onDone();
      }}
      onClose={onClose}
    >
      <MotivoField
        value={motivo}
        onChange={setMotivo}
        opciones={['Solicitud del cliente', 'Falta de pago', 'Cierre de cuenta', 'Decisión del owner']}
        label="Motivo de la cancelación"
      />
    </AccionModal>
  );
}
