import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { ActivarAvisosPush } from '@shared/components/ActivarAvisosPush';

/**
 * Ajustes → Notificaciones (admin).
 *
 * Hasta ahora la campana del admin estaba SIEMPRE vacía: ningún evento del
 * sistema escribía un aviso dirigido al gym. Ahora el gym recibe los suyos
 * (socio nuevo, cancelación de última hora, cobro rechazado) y desde acá puede
 * activarlos también en el teléfono.
 */
export default function AjustesNotificaciones() {
  const { usuario } = useAuth();
  const tenant = useTenant();

  return (
    <div className="adm-page">
      <p className="ek-eyebrow" style={{ marginBottom: '4px' }}>AJUSTES</p>
      <h1
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(28px, 5vw, 40px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          margin: 0,
          marginBottom: '6px'
        }}
      >
        Notificaciones
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '24px', lineHeight: 1.55 }}>
        Los avisos del gym llegan siempre a la campana. Activalos también en el teléfono para
        enterarte sin tener el panel abierto.
      </p>

      {usuario?.id && (
        <ActivarAvisosPush
          usuarioId={usuario.id}
          tenantId={tenant.id}
          descripcion="Socio nuevo, cancelaciones de última hora y cobros rechazados."
        />
      )}

      <section className="ek-card" style={{ padding: '20px', marginTop: '16px', display: 'block' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ fontSize: '11px', marginBottom: '12px' }}>
          QUÉ AVISOS RECIBE EL GYM
        </p>
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            fontSize: '13.5px',
            color: 'var(--sala-text-secondary)',
            lineHeight: 1.5
          }}
        >
          <li><strong style={{ color: 'var(--sala-text-primary)' }}>Socio nuevo</strong> — alguien se dio de alta.</li>
          <li><strong style={{ color: 'var(--sala-text-primary)' }}>Cancelación de última hora</strong> — un socio canceló con menos de 4 horas: se liberó un lugar.</li>
          <li><strong style={{ color: 'var(--sala-text-primary)' }}>Cobro rechazado</strong> — le falló la tarjeta a un socio.</li>
        </ul>
      </section>
    </div>
  );
}
