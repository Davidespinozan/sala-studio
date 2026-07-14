import { useEffect, useState } from 'react';
import { Bell, BellOff, Smartphone, ShieldOff } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import {
  activarPush,
  desactivarPush,
  estadoPush,
  type EstadoPush
} from '@shared/lib/push';

/**
 * Botón de "avisos en el teléfono". El mismo para los tres roles: el socio, la
 * recepción y el admin. Cada rol lo monta en su pantalla de ajustes.
 *
 * Los estados raros importan más que el feliz: si el navegador no soporta push,
 * si el usuario bloqueó los avisos, o si está en iOS sin instalar la app, un
 * botón que simplemente "no hace nada" deja al usuario sin entender por qué no
 * le llegan los avisos. Cada caso dice qué pasa y qué hacer.
 */
export function ActivarAvisosPush({
  usuarioId,
  tenantId,
  descripcion
}: {
  usuarioId: string;
  tenantId: string;
  /** Qué avisos va a recibir este rol. */
  descripcion?: string;
}) {
  const toast = useToast();
  const [estado, setEstado] = useState<EstadoPush | null>(null);
  const [procesando, setProcesando] = useState(false);

  useEffect(() => {
    void estadoPush().then(setEstado);
  }, []);

  async function alternar() {
    setProcesando(true);
    try {
      if (estado === 'activo') {
        await desactivarPush();
        setEstado('inactivo');
        toast.info('Avisos desactivados en este dispositivo.');
      } else {
        await activarPush(usuarioId, tenantId);
        setEstado('activo');
        toast.success('¡Listo! Vas a recibir los avisos en este dispositivo.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'DENEGADO') {
        setEstado('denegado');
        toast.error('Bloqueaste los avisos. Habilitalos en los ajustes del navegador.');
      } else {
        toast.error(msg || 'No pudimos cambiar los avisos.');
      }
    } finally {
      setProcesando(false);
    }
  }

  // Mientras resuelve el estado no mostramos nada (evita un parpadeo del botón).
  if (estado === null) return null;

  // El navegador no puede: no tiene sentido mostrar un botón que no va a andar.
  if (estado === 'no-soportado') return null;

  const activo = estado === 'activo';

  return (
    <section className="ek-card" style={{ padding: '20px', display: 'block' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        <span
          style={{
            width: 42,
            height: 42,
            flexShrink: 0,
            borderRadius: '50%',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--sala-primary-light)',
            color: 'var(--sala-primary)'
          }}
        >
          {activo ? <Bell size={19} strokeWidth={2.25} /> : <BellOff size={19} strokeWidth={2.25} />}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontWeight: 700, fontSize: '15px' }}>Avisos en el teléfono</p>
          <p
            style={{
              margin: '4px 0 0',
              fontSize: '13px',
              color: 'var(--sala-text-secondary)',
              lineHeight: 1.5
            }}
          >
            {descripcion ?? 'Recibí los avisos importantes aunque no tengas la app abierta.'}
          </p>

          {/* iOS: Safari solo entrega push si la app está instalada. Sin esto, el
              botón fallaría sin explicación. */}
          {estado === 'necesita-instalar' && (
            <p
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                marginTop: '12px',
                padding: '8px 12px',
                borderRadius: '8px',
                background: 'var(--sala-warning-bg)',
                color: 'var(--sala-warning)',
                fontSize: '12.5px',
                fontWeight: 600
              }}
            >
              <Smartphone size={15} strokeWidth={2.25} />
              En iPhone, primero agregá la app a tu pantalla de inicio.
            </p>
          )}

          {estado === 'denegado' && (
            <p
              style={{
                display: 'inline-flex',
                alignItems: 'flex-start',
                gap: '6px',
                marginTop: '12px',
                padding: '8px 12px',
                borderRadius: '8px',
                background: 'var(--sala-error-bg)',
                color: 'var(--sala-error)',
                fontSize: '12.5px',
                fontWeight: 600,
                lineHeight: 1.45
              }}
            >
              <ShieldOff size={15} strokeWidth={2.25} style={{ flexShrink: 0, marginTop: '1px' }} />
              Bloqueaste los avisos en este navegador. Habilitalos desde sus ajustes de sitio.
            </p>
          )}

          {(estado === 'activo' || estado === 'inactivo') && (
            <button
              type="button"
              onClick={() => void alternar()}
              disabled={procesando}
              className={activo ? 'ek-cta ek-cta--secondary' : 'ek-cta'}
              style={{ marginTop: '14px', padding: '10px 18px', fontSize: '13px' }}
            >
              {procesando ? 'Un momento…' : activo ? 'Desactivar avisos' : 'Activar avisos'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
