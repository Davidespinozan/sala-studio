import { Link } from 'react-router-dom';
import { LegalLayout, LegalSection } from '../components/LegalLayout';

const ACTUALIZADO = '11 de julio de 2026';

export default function Terminos() {
  return (
    <LegalLayout titulo="Términos y condiciones" actualizado={ACTUALIZADO}>
      <p style={{ margin: '0 0 24px' }}>
        Al crear una cuenta aceptás estos términos. <strong>SALA Studio</strong> es la plataforma que
        el gimnasio o estudio (el establecimiento) usa para gestionar reservas y membresías. El
        servicio de entrenamiento lo presta el establecimiento; SALA provee la tecnología.
      </p>

      <LegalSection titulo="Tu cuenta">
        <p style={{ margin: 0 }}>
          Sos responsable de los datos que proporcionás y de mantener tu contraseña segura. La
          actividad realizada desde tu cuenta es tu responsabilidad. Avisá al establecimiento si
          detectás un uso no autorizado.
        </p>
      </LegalSection>

      <LegalSection titulo="Reservas y cancelaciones">
        <p style={{ margin: 0 }}>
          Las reservas, cupos y políticas de cancelación las define cada establecimiento (por
          ejemplo, con cuánta anticipación podés cancelar sin perder tu crédito). Cancelar fuera de
          la ventana definida puede implicar la pérdida del crédito o cargo, según las reglas del
          establecimiento.
        </p>
      </LegalSection>

      <LegalSection titulo="Pagos">
        <p style={{ margin: 0 }}>
          Cuando corresponda, el establecimiento cobra tu membresía a través de <strong>Stripe</strong>.
          SALA no es la parte que te cobra: facilita el procesamiento del pago en nombre del
          establecimiento. Los importes, ciclos y reembolsos dependen del plan que contrataste y de
          las políticas del establecimiento.
        </p>
      </LegalSection>

      <LegalSection titulo="Uso aceptable">
        <p style={{ margin: 0 }}>
          No podés usar el servicio para fines ilícitos, suplantar a otras personas, ni intentar
          vulnerar la seguridad de la plataforma. Podemos suspender cuentas que incumplan estos
          términos.
        </p>
      </LegalSection>

      <LegalSection titulo="Responsabilidad">
        <p style={{ margin: 0 }}>
          El servicio se ofrece "tal cual". En la medida que lo permita la ley, SALA no es
          responsable por la disponibilidad de clases, la prestación del servicio por parte del
          establecimiento, ni por daños indirectos derivados del uso de la plataforma.
        </p>
      </LegalSection>

      <LegalSection titulo="Cambios">
        <p style={{ margin: 0 }}>
          Podemos modificar el servicio o estos términos. Publicaremos la versión vigente en esta
          página. Consultá también nuestro{' '}
          <Link to="/privacidad" style={{ color: 'var(--sala-primary)' }}>Aviso de privacidad</Link>.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
