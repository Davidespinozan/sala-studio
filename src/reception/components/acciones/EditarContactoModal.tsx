import { useState } from 'react';
import { AccionModal } from '@shared/components/AccionModal';
import { useAccionRecepcion } from '../../hooks/useAccionRecepcion';

interface Props {
  socioId: string;
  socioNombre: string;
  telefonoActual: string | null;
  emailActual: string | null;
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Edita el contacto (teléfono / email) del socio. El email de acceso (login)
 *  no cambia acá — es solo el contacto. */
export function EditarContactoModal({
  socioId, socioNombre, telefonoActual, emailActual, isOpen, onClose, onDone
}: Props) {
  const [telefono, setTelefono] = useState(telefonoActual ?? '');
  const [email, setEmail] = useState(emailActual ?? '');
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_editar_contacto' });

  const emailTrim = email.trim();
  const emailOk = emailTrim === '' || EMAIL_RE.test(emailTrim);
  const cambio =
    telefono.trim() !== (telefonoActual ?? '') ||
    emailTrim.toLowerCase() !== (emailActual ?? '').toLowerCase();

  return (
    <AccionModal
      isOpen={isOpen}
      title="Editar contacto"
      description={`Actualizá el contacto de ${socioNombre}. El email de acceso (login) no cambia acá.`}
      variant="info"
      confirmLabel="Guardar"
      cancelLabel="Volver"
      canConfirm={emailOk && cambio}
      onConfirm={async () => {
        await ejecutar({ p_usuario_id: socioId, p_telefono: telefono.trim(), p_email: emailTrim });
        await onDone();
      }}
      onClose={onClose}
    >
      <label className="ek-label">
        Teléfono
        <input
          className="ek-input"
          type="tel"
          value={telefono}
          onChange={(e) => setTelefono(e.target.value)}
          placeholder="+52 55 1234 5678"
        />
      </label>
      <label className="ek-label" style={{ marginTop: '12px' }}>
        Email de contacto
        <input
          className="ek-input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="socio@email.com"
        />
        {!emailOk && <span className="ek-error-text">El email no tiene un formato válido.</span>}
      </label>
    </AccionModal>
  );
}
