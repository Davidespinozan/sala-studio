import { useState } from 'react';
import { AccionModal } from '@shared/components/AccionModal';
import { MotivoField } from '@shared/components/MotivoField';
import { useToast } from '@shared/hooks/useToast';
import { llamarCancelacionStripe } from '@shared/lib/cancelacionStripe';
import { translateActionError } from '../../lib/traducirErrorAccion';

interface Props {
  socioId: string;
  socioNombre: string;
  /** 'programar' = detener la renovación (conserva acceso hasta fin de periodo).
   *  'retirar' = deshacer una cancelación ya programada. */
  modo: 'programar' | 'retirar';
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

/**
 * Cancelación/retiro de una membresía con suscripción Stripe (BLOCK 2) — vía
 * `cancelacion-stripe`, NO vía `recepcion_cancelar_membresia` (ese RPC es solo
 * para planes manuales/paquetes; ver CancelarMembresiaModal). Mantiene acceso
 * hasta el fin del periodo ya pagado; sin reembolsos ni terminación inmediata.
 */
export function CancelacionStripeModal({ socioId, socioNombre, modo, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const toast = useToast();
  const esProgramar = modo === 'programar';

  const opciones = esProgramar
    ? ['Solicitud del cliente', 'Cierre de cuenta', 'Decisión del owner']
    : ['Solicitud del cliente', 'Cambio de opinión'];

  return (
    <AccionModal
      isOpen={isOpen}
      title={esProgramar ? 'Cancelar membresía (Stripe)' : 'Retirar cancelación'}
      description={
        esProgramar
          ? `Programas la cancelación de ${socioNombre}: conserva el acceso hasta el fin del periodo ya pagado y después no se renueva. No se hace ningún reembolso.`
          : `Retiras la cancelación programada de ${socioNombre}: su plan vuelve a renovarse normalmente.`
      }
      variant={esProgramar ? 'danger' : 'info'}
      confirmLabel={esProgramar ? 'Programar cancelación' : 'Retirar cancelación'}
      cancelLabel="Volver"
      canConfirm={motivo.trim().length > 0}
      onConfirm={async () => {
        try {
          const res = await llamarCancelacionStripe({
            usuarioId: socioId,
            accion: modo,
            motivo: motivo.trim()
          });
          if (res.estado === 'procesando') {
            toast.info('La solicitud quedó procesándose — puede tardar unos minutos en reflejarse acá. No hace falta repetirla.');
          } else if (res.estado === 'sin_efecto_membresia_terminal') {
            toast.info('Esa membresía ya está cerrada; no hubo cambios.');
          } else {
            toast.success(esProgramar ? 'Cancelación programada.' : 'Cancelación retirada.');
          }
          await onDone();
        } catch (e) {
          throw new Error(translateActionError(e));
        }
      }}
      onClose={onClose}
    >
      <MotivoField
        value={motivo}
        onChange={setMotivo}
        opciones={opciones}
        label={esProgramar ? 'Motivo de la cancelación' : 'Motivo del retiro'}
      />
    </AccionModal>
  );
}
