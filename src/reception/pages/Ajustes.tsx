import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { ActivarAvisosPush } from '@shared/components/ActivarAvisosPush';

/**
 * Ajustes de recepción. Es la primera pantalla de ajustes que tiene el rol: no
 * existía ninguna. Hoy trae los avisos; es el lugar donde van a vivir las
 * preferencias del mostrador cuando haya más.
 */
export default function Ajustes() {
  const { usuario } = useAuth();
  const tenant = useTenant();

  return (
    <div className="rec-page">
      <p className="ek-eyebrow" style={{ marginBottom: '4px' }}>RECEPCIÓN</p>
      <h1
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(24px, 5vw, 32px)',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          margin: 0,
          marginBottom: '6px'
        }}
      >
        Ajustes
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', margin: 0, marginBottom: '20px', lineHeight: 1.5 }}>
        Los avisos del mostrador llegan a la campana. Activalos en el teléfono para enterarte sin
        estar mirando la pantalla.
      </p>

      {usuario?.id && (
        <ActivarAvisosPush
          usuarioId={usuario.id}
          tenantId={tenant.id}
          descripcion="Socio nuevo, cancelaciones de última hora y cobros rechazados."
        />
      )}
    </div>
  );
}
