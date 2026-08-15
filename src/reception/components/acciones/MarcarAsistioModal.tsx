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

/**
 * Corrige la asistencia: marca como PRESENTE una reserva que quedó no_show o
 * cancelada. El caso típico: el socio sí fue, pero nadie le hizo el check-in y el
 * cron lo marcó como inasistencia. Solo aplica a clases ya pasadas.
 */
export function MarcarAsistioModal({ reservaId, reservaLabel, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const { ejecutar } = useAccionRecepcion({ rpcName: 'admin_marcar_asistencia' });

  return (
    <AccionModal
      isOpen={isOpen}
      title="Marcar que sí asistió"
      description={`Marcas como presente la reserva de ${reservaLabel}. Úsalo cuando el socio sí fue pero no le hicieron el check-in.`}
      variant="info"
      confirmLabel="Marcar asistió"
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
        opciones={['Sí asistió, no le hicieron check-in', 'Error de registro', 'Llegó y se registró tarde']}
        label="Motivo"
      />
    </AccionModal>
  );
}
