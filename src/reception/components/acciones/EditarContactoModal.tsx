import { useEffect, useState } from 'react';
import { AccionModal } from '@shared/components/AccionModal';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
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

/** Edita el contacto (teléfono / email) y la fecha de nacimiento del socio. El
 *  email de acceso (login) no cambia acá — es solo el contacto. El cumpleaños
 *  vive en la tabla privada `usuarios_datos_privados` (RLS: la escribe recepción
 *  y admin), por eso se guarda con un upsert aparte. */
export function EditarContactoModal({
  socioId, socioNombre, telefonoActual, emailActual, isOpen, onClose, onDone
}: Props) {
  const tenant = useTenant();
  const [telefono, setTelefono] = useState(telefonoActual ?? '');
  const [email, setEmail] = useState(emailActual ?? '');
  // Fecha de nacimiento (tabla privada). Se carga al abrir y se compara para
  // saber si cambió. '' = sin fecha.
  const [fechaNac, setFechaNac] = useState('');
  const [fechaNacOrig, setFechaNacOrig] = useState('');
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_editar_contacto' });

  useEffect(() => {
    if (!isOpen) return;
    let cancel = false;
    void (async () => {
      const { data } = await (supabase as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: { fecha_nacimiento: string | null } | null }> };
          };
        };
      })
        .from('usuarios_datos_privados')
        .select('fecha_nacimiento')
        .eq('usuario_id', socioId)
        .maybeSingle();
      if (cancel) return;
      const fn = data?.fecha_nacimiento ?? '';
      setFechaNac(fn);
      setFechaNacOrig(fn);
    })();
    return () => { cancel = true; };
  }, [isOpen, socioId]);

  const emailTrim = email.trim();
  const emailOk = emailTrim === '' || EMAIL_RE.test(emailTrim);
  const contactoCambio =
    telefono.trim() !== (telefonoActual ?? '') ||
    emailTrim.toLowerCase() !== (emailActual ?? '').toLowerCase();
  const fechaCambio = fechaNac !== fechaNacOrig;
  const cambio = contactoCambio || fechaCambio;

  return (
    <AccionModal
      isOpen={isOpen}
      title="Editar contacto"
      description={`Actualizá el contacto y la fecha de nacimiento de ${socioNombre}. El email de acceso (login) no cambia acá.`}
      variant="info"
      confirmLabel="Guardar"
      cancelLabel="Volver"
      canConfirm={emailOk && cambio}
      onConfirm={async () => {
        // El contacto va por su RPC (tel/email); el cumpleaños por upsert directo
        // a la tabla privada (la RLS ya permite a recepción/admin).
        if (contactoCambio) {
          await ejecutar({ p_usuario_id: socioId, p_telefono: telefono.trim(), p_email: emailTrim });
        }
        if (fechaCambio) {
          const { error } = await (supabase as unknown as {
            from: (t: string) => {
              upsert: (row: Record<string, unknown>, opts: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
            };
          })
            .from('usuarios_datos_privados')
            .upsert(
              { usuario_id: socioId, tenant_id: tenant.id, fecha_nacimiento: fechaNac || null },
              { onConflict: 'usuario_id' }
            );
          if (error) throw new Error('No pudimos guardar la fecha de nacimiento.');
          setFechaNacOrig(fechaNac);
        }
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
      <label className="ek-label" style={{ marginTop: '12px' }}>
        Fecha de nacimiento
        <input
          className="ek-input"
          type="date"
          value={fechaNac}
          onChange={(e) => setFechaNac(e.target.value)}
        />
      </label>
    </AccionModal>
  );
}
