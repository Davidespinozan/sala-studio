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

/** Envía un aviso in-app puntual al socio (le llega a su campana). Queda en la
 *  bitácora con autor + fecha. No es el contacto ni una nota interna. */
export function EnviarAvisoModal({ socioId, socioNombre, isOpen, onClose, onDone }: Props) {
  const [titulo, setTitulo] = useState('');
  const [mensaje, setMensaje] = useState('');
  const { ejecutar } = useAccionRecepcion({ rpcName: 'enviar_aviso_socio' });

  return (
    <AccionModal
      isOpen={isOpen}
      title="Enviar aviso"
      description={`Un mensaje que le llega a ${socioNombre} en la app (su campana de notificaciones).`}
      variant="info"
      confirmLabel="Enviar"
      cancelLabel="Volver"
      canConfirm={titulo.trim().length > 0 && mensaje.trim().length > 0}
      onConfirm={async () => {
        await ejecutar({ p_usuario_id: socioId, p_titulo: titulo.trim(), p_mensaje: mensaje.trim() });
        await onDone();
      }}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <label className="ek-label">
          Título
          <input
            className="ek-input"
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
            placeholder="Ej: Tu clase de mañana se movió"
            maxLength={80}
          />
        </label>
        <label className="ek-label">
          Mensaje
          <textarea
            className="ek-input"
            rows={4}
            value={mensaje}
            onChange={(e) => setMensaje(e.target.value)}
            placeholder="Ej: La clase de las 8:00 pasó a las 9:00. ¡Te esperamos!"
            maxLength={500}
          />
          <span style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)' }}>{mensaje.length}/500</span>
        </label>
      </div>
    </AccionModal>
  );
}
