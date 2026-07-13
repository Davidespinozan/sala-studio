import { ArrowRight, CalendarPlus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTenant } from '@shared/hooks/useTenant';
import { type Clase } from '@member/logic/claseAdapter';

interface Props {
  /** null = el socio no tiene ninguna clase reservada. */
  clase: Clase | null;
  reservaId: string | null;
}

/**
 * Hero dominante del Home ("Tu próxima clase", donde está el botón Mi QR): una
 * EXPERIENCIA con foto de fondo + scrim para que el texto se lea. La foto es la
 * IMAGEN DEL SOCIO que el tenant eligió en admin (config.member.qr_bg_url); si
 * no la subió, cae a la foto de la sala de esa clase, y si no, a su gradiente.
 *
 * Se muestra SIEMPRE, con o sin reserva: antes, el socio sin reserva veía un
 * bloque chico sin foto y el Home perdía toda su presencia justo cuando más falta
 * hace empujarlo a reservar. Sin reserva cambia el mensaje y el botón, no el peso
 * visual.
 */
export function ProximaClaseHero({ clase, reservaId }: Props) {
  const tenant = useTenant();
  const heroImg = (
    (tenant.config as Record<string, unknown> | null)?.member as Record<string, unknown> | undefined
  )?.qr_bg_url as string | undefined;
  // Imagen del socio (admin) → foto de la sala de la clase → gradiente de marca.
  const bg = heroImg || clase?.imagenUrl;
  const hayReserva = !!clase && !!reservaId;

  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: '22px',
        minHeight: '264px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        padding: '22px',
        boxShadow: '0 24px 56px -18px rgba(0, 0, 0, 0.55)',
        ...(bg
          ? {
              backgroundColor: '#0c100e',
              backgroundImage: `url(${bg})`,
              backgroundSize: 'cover',
              // Anclá la foto a la DERECHA: el scrim oscuro y el texto van a la
              // izquierda, así que si el alto/ancho obliga a recortar, que recorte
              // del lado izquierdo (tapado por el scrim) y nunca del derecho.
              backgroundPosition: 'right center'
            }
          : { background: 'var(--grad-immersive)' })
      }}
    >
      {/* Scrim: oscuro suave a la izquierda + abajo → la FOTO se ve y el texto
          igual se lee. Más liviano que un overlay que la tape. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(108deg, rgba(7, 11, 9, 0.94) 0%, rgba(7, 11, 9, 0.7) 32%, rgba(7, 11, 9, 0.28) 62%, rgba(7, 11, 9, 0) 100%), linear-gradient(0deg, rgba(7, 11, 9, 0.78) 0%, transparent 52%)'
        }}
      />

      <div style={{ position: 'relative', zIndex: 1 }}>
        <p
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'color-mix(in srgb, var(--sala-accent), white 38%)',
            margin: '0 0 9px'
          }}
        >
          Tu próxima clase
        </p>

        <h2
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(28px, 7vw, 36px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.05,
            margin: '0 0 8px',
            color: '#fff'
          }}
        >
          {hayReserva ? clase.nombre : 'Todavía no reservaste'}
        </h2>

        {hayReserva ? (
          <>
            <p
              style={{
                fontSize: '15px',
                fontWeight: 600,
                color: 'rgba(255, 255, 255, 0.9)',
                margin: '0 0 3px',
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {clase.horaHumanaLabel}
            </p>

            <p style={{ fontSize: '13px', color: 'rgba(255, 255, 255, 0.66)', margin: '0 0 20px' }}>
              {clase.instructorNombre ? `con ${clase.instructorNombre}` : 'Instructor por confirmar'}
              {clase.salaNombre && clase.salaNombre !== clase.nombre && ` · ${clase.salaNombre}`}
            </p>
          </>
        ) : (
          <p
            style={{
              fontSize: '14px',
              color: 'rgba(255, 255, 255, 0.72)',
              margin: '0 0 20px',
              maxWidth: '320px',
              lineHeight: 1.5
            }}
          >
            Reservá tu próxima clase y va a aparecer acá, con tu código QR para entrar.
          </p>
        )}

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          {!hayReserva ? (
            <Link
              to="/app/reservar"
              className="ek-lift"
              style={{
                padding: '11px 22px',
                minHeight: '42px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '999px',
                background: 'var(--grad-accent)',
                color: 'var(--sala-text-on-accent)',
                border: '1px solid var(--sala-accent)',
                fontSize: '13px',
                fontWeight: 600,
                textDecoration: 'none',
                boxShadow: '0 6px 18px var(--sala-accent-dim), inset 0 1px 0 rgba(255, 255, 255, 0.18)',
                gap: '6px'
              }}
            >
              Reservar ahora
              <CalendarPlus size={16} strokeWidth={2.25} />
            </Link>
          ) : (
          <>
          <Link
            to={`/app/clase/${encodeURIComponent(clase.id)}`}
            style={{
              padding: '11px 18px',
              minHeight: '42px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '999px',
              background: 'rgba(255, 255, 255, 0.12)',
              color: '#fff',
              border: '1px solid rgba(255, 255, 255, 0.28)',
              fontSize: '13px',
              fontWeight: 600,
              textDecoration: 'none',
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)'
            }}
          >
            Ver detalle
          </Link>
          <Link
            to={`/app/qr/${reservaId}`}
            className="ek-lift"
            style={{
              padding: '11px 22px',
              minHeight: '42px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '999px',
              background: 'var(--grad-accent)',
              color: 'var(--sala-text-on-accent)',
              border: '1px solid var(--sala-accent)',
              fontSize: '13px',
              fontWeight: 600,
              textDecoration: 'none',
              boxShadow: '0 6px 18px var(--sala-accent-dim), inset 0 1px 0 rgba(255, 255, 255, 0.18)',
              gap: '6px'
            }}
          >
            Mi QR
            <ArrowRight size={16} strokeWidth={2.25} />
          </Link>
          </>
          )}
        </div>
      </div>
    </div>
  );
}
