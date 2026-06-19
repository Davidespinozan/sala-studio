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

export function RecargarCreditosModal({ socioId, socioNombre, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const [cantidad, setCantidad] = useState<number>(1);
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_recargar_creditos' });

  return (
    <AccionModal
      isOpen={isOpen}
      title="Recargar créditos"
      description={`Sumas créditos al paquete de ${socioNombre}.`}
      variant="info"
      confirmLabel="Recargar"
      canConfirm={motivo.trim().length > 0 && cantidad >= 1}
      onConfirm={async () => {
        await ejecutar({ p_usuario_id: socioId, p_cantidad: cantidad, p_motivo: motivo });
        await onDone();
      }}
      onClose={onClose}
    >
      <div className="ek-form-field" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
        <label className="ek-label" htmlFor="recargar-cantidad">Cantidad de créditos</label>
        <input
          id="recargar-cantidad"
          className="ek-input"
          type="number"
          min={1}
          step={1}
          value={cantidad}
          onChange={(e) => setCantidad(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
        />
      </div>

      <MotivoField
        value={motivo}
        onChange={setMotivo}
        opciones={['Pago en efectivo', 'Pago por transferencia', 'Compensación por error', 'Cortesía del owner']}
        label="Motivo de la recarga"
      />
    </AccionModal>
  );
}
