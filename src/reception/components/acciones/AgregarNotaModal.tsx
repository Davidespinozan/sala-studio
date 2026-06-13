import { useState } from 'react';
import { AccionModal } from '@shared/components/AccionModal';
import { useAccionRecepcion } from '../../hooks/useAccionRecepcion';

interface Props {
  socioId: string;
  socioNombre: string;
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

/** Agrega una nota sobre el socio (queda con autor + fecha). */
export function AgregarNotaModal({ socioId, socioNombre, isOpen, onClose, onDone }: Props) {
  const [texto, setTexto] = useState('');
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_agregar_nota' });

  return (
    <AccionModal
      isOpen={isOpen}
      title="Agregar nota"
      description={`Una nota sobre ${socioNombre}. Queda registrada con tu nombre y la fecha.`}
      variant="info"
      confirmLabel="Guardar nota"
      cancelLabel="Volver"
      canConfirm={texto.trim().length > 0}
      onConfirm={async () => {
        await ejecutar({ p_usuario_id: socioId, p_texto: texto.trim() });
        await onDone();
      }}
      onClose={onClose}
    >
      <label className="ek-label">
        Nota
        <textarea
          className="ek-input"
          rows={4}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder="Ej: Llamó para reprogramar; prefiere clases de la mañana."
          maxLength={1000}
        />
        <span style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)' }}>{texto.length}/1000</span>
      </label>
    </AccionModal>
  );
}
