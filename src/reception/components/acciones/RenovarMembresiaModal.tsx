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

export function RenovarMembresiaModal({ socioId, socioNombre, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_renovar_membresia' });

  return (
    <AccionModal
      isOpen={isOpen}
      title="Renovar membresía"
      description={`Renuevas el mismo plan a ${socioNombre}. Refresca el período y los créditos según el tier.`}
      variant="info"
      confirmLabel="Renovar"
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
        opciones={['Pago en efectivo', 'Pago por transferencia', 'Cortesía del owner', 'Renovación automática mensual']}
        label="Motivo de la renovación"
      />
    </AccionModal>
  );
}
