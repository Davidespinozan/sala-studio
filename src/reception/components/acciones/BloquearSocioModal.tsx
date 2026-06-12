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

// 'YYYY-MM-DD' → fin de ese día (ISO). El RPC exige p_hasta > now().
function isoFinDelDia(fecha: string): string {
  return new Date(`${fecha}T23:59:59`).toISOString();
}

const HOY = new Date().toISOString().slice(0, 10);

export function BloquearSocioModal({ socioId, socioNombre, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const [hasta, setHasta] = useState('');
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_bloquear_socio' });

  return (
    <AccionModal
      isOpen={isOpen}
      title="Bloquear socio"
      description={`Bloqueás el acceso de ${socioNombre} hasta la fecha elegida. No va a poder reservar.`}
      variant="danger"
      confirmLabel="Bloquear"
      cancelLabel="Volver"
      canConfirm={motivo.trim().length > 0 && hasta.length > 0}
      onConfirm={async () => {
        await ejecutar({ p_usuario_id: socioId, p_hasta: isoFinDelDia(hasta), p_motivo: motivo });
        await onDone();
      }}
      onClose={onClose}
    >
      <div className="ek-form-field" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
        <label className="ek-label" htmlFor="bloq-hasta">Bloqueado hasta</label>
        <input
          id="bloq-hasta"
          type="date"
          className="ek-input"
          value={hasta}
          min={HOY}
          onChange={(e) => setHasta(e.target.value)}
        />
      </div>

      <MotivoField
        value={motivo}
        onChange={setMotivo}
        opciones={['2 no-shows seguidos', 'Conducta inadecuada', 'Falta de pago', 'Decisión del owner']}
        label="Motivo del bloqueo"
      />
    </AccionModal>
  );
}
