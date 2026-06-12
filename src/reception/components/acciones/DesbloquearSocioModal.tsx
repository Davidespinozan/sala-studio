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

export function DesbloquearSocioModal({ socioId, socioNombre, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_desbloquear_socio' });

  return (
    <AccionModal
      isOpen={isOpen}
      title="Desbloquear socio"
      description={`Levantás el bloqueo de ${socioNombre}. Va a poder volver a reservar.`}
      variant="info"
      confirmLabel="Desbloquear"
      cancelLabel="Volver"
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
        opciones={['Cliente justificó la falta', 'Error operativo (no fue real)', 'Decisión del owner']}
        label="Motivo del desbloqueo"
      />
    </AccionModal>
  );
}
