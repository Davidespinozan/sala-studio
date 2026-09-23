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
      title="Ajustar créditos (sin cobro)"
      description={`Regala o corrige créditos de ${socioNombre}.`}
      variant="info"
      confirmLabel="Ajustar"
      canConfirm={motivo.trim().length > 0 && cantidad >= 1}
      onConfirm={async () => {
        await ejecutar({ p_usuario_id: socioId, p_cantidad: cantidad, p_motivo: motivo });
        await onDone();
      }}
      onClose={onClose}
    >
      {/* Aviso: esta acción NO cobra. Evita que se use por error creyendo que se
          registra un pago (el dinero se registra en Asignar/Cambiar plan). */}
      <div
        style={{
          background: 'var(--sala-warning-bg)',
          border: '1px solid var(--sala-warning)',
          borderRadius: '10px',
          padding: '10px 12px',
          marginBottom: '12px',
          fontSize: '12px',
          lineHeight: 1.5,
          color: 'var(--sala-text-primary)'
        }}
      >
        <strong>Esto NO cobra dinero</strong> ni entra a la Caja. Solo suma o corrige créditos.
        Para <strong>vender</strong> clases o un plan, usa <strong>Asignar</strong> o <strong>Cambiar plan</strong>.
      </div>

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
        opciones={['Compensación por error', 'Cortesía del owner', 'Ajuste manual']}
        label="Motivo del ajuste"
      />
    </AccionModal>
  );
}
