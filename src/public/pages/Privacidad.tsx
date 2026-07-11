import { LegalLayout, LegalSection } from '../components/LegalLayout';

const ACTUALIZADO = '11 de julio de 2026';

export default function Privacidad() {
  return (
    <LegalLayout titulo="Aviso de privacidad" actualizado={ACTUALIZADO}>
      <p style={{ margin: '0 0 24px' }}>
        Este aviso explica qué datos personales tratamos cuando usás <strong>SALA Studio</strong>
        {' '}(la plataforma) para reservar clases y gestionar tu membresía en un gimnasio o estudio
        (el establecimiento). Tu relación de servicio es con el establecimiento; SALA opera la
        plataforma y procesa los datos en su nombre.
      </p>

      <LegalSection titulo="Qué datos recolectamos">
        <ul style={{ margin: 0, paddingLeft: '20px' }}>
          <li>Datos de cuenta: nombre, correo electrónico y, si lo proporcionás, teléfono.</li>
          <li>Datos de uso: reservas, asistencias, cancelaciones y estado de tu membresía.</li>
          <li>
            Datos de pago: cuando pagás tu membresía, el cobro lo procesa <strong>Stripe</strong>.
            SALA no almacena los datos completos de tu tarjeta; solo guardamos un identificador de
            cliente y los últimos 4 dígitos para mostrarte tu método de pago.
          </li>
        </ul>
      </LegalSection>

      <LegalSection titulo="Para qué los usamos">
        <ul style={{ margin: 0, paddingLeft: '20px' }}>
          <li>Crear y operar tu cuenta y tus reservas.</li>
          <li>Gestionar tu membresía y, si aplica, los cobros a través del establecimiento.</li>
          <li>Enviarte avisos operativos (recordatorios de clase, cambios, notificaciones).</li>
          <li>Mantener la seguridad del servicio y prevenir abusos.</li>
        </ul>
      </LegalSection>

      <LegalSection titulo="Con quién los compartimos">
        <p style={{ margin: 0 }}>
          Compartimos tus datos con el <strong>establecimiento</strong> al que te suscribís (para que
          te atienda), y con proveedores que hacen funcionar el servicio: <strong>Stripe</strong>
          {' '}(procesamiento de pagos) e infraestructura de hosting y base de datos. No vendemos tus
          datos ni los cedemos a terceros con fines publicitarios.
        </p>
      </LegalSection>

      <LegalSection titulo="Tus derechos">
        <p style={{ margin: 0 }}>
          Podés solicitar acceder, corregir o eliminar tus datos, y dar de baja tu cuenta.
          Escribinos al establecimiento donde estás inscrito o a través de los datos de contacto de
          la plataforma. Atenderemos tu solicitud conforme a la legislación aplicable.
        </p>
      </LegalSection>

      <LegalSection titulo="Seguridad y conservación">
        <p style={{ margin: 0 }}>
          Aplicamos medidas razonables para proteger tus datos (cifrado en tránsito, control de
          acceso por roles). Conservamos la información mientras tu cuenta esté activa o mientras sea
          necesario para cumplir obligaciones legales.
        </p>
      </LegalSection>

      <LegalSection titulo="Cambios a este aviso">
        <p style={{ margin: 0 }}>
          Podemos actualizar este aviso. Publicaremos la versión vigente en esta página con su fecha
          de actualización.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
