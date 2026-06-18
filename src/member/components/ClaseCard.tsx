import { Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import { estadoCupos, type Clase } from '@member/logic/claseAdapter';
import { CoachAvatar, SalaImg } from './claseMedia';

interface Props {
  clase: Clase;
  /** Si está presente y la clase está llena/inaccesible, dim la card. */
  ya_reservada?: boolean;
}

/** Card para el scroll horizontal del Home ("Clases de hoy"): foto de la sala
 *  arriba, nombre de la clase + hora, coach con avatar, y cupos. */
export function ClaseCard({ clase, ya_reservada }: Props) {
  const esCancelada = clase.status === 'cancelada';
  const estado = estadoCupos(clase);
  const llena = estado === 'llena';
  const pocos = estado === 'pocos';

  return (
    <Link
      to={`/app/clase/${encodeURIComponent(clase.id)}`}
      aria-label={`${clase.nombre} ${clase.horaLabel}`}
      style={{
        flexShrink: 0,
        width: '190px',
        background: esCancelada ? 'var(--sala-bg)' : 'var(--sala-surface)',
        border: `1px solid ${pocos && !esCancelada ? 'var(--sala-accent-light)' : 'var(--sala-border)'}`,
        borderRadius: '16px',
        display: 'flex',
        flexDirection: 'column',
        textDecoration: 'none',
        color: 'var(--sala-text-primary)',
        opacity: esCancelada ? 0.6 : llena ? 0.55 : 1,
        boxShadow: '0 1px 3px rgba(26, 31, 28, 0.04)',
        overflow: 'hidden',
        transition: 'border-color 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease'
      }}
    >
      {/* Foto de la sala — banner superior */}
      <SalaImg
        url={clase.imagenUrl}
        nombre={clase.salaNombre}
        disciplina={clase.disciplina}
        dim={esCancelada}
        inicialSize={34}
        style={{
          width: '100%',
          height: '92px',
          borderRadius: 0,
          border: 'none',
          borderBottom: '1px solid var(--sala-border)'
        }}
      />

      <div
        style={{
          padding: '12px 14px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '7px',
          flex: 1
        }}
      >
        {/* Nombre de la clase + hora */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', minWidth: 0 }}>
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '15px',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              lineHeight: 1.2,
              margin: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0
            }}
          >
            {clase.nombre}
          </p>
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '15px',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: 'var(--sala-text-tertiary)',
              margin: 0,
              flexShrink: 0,
              fontVariantNumeric: 'tabular-nums'
            }}
          >
            {clase.horaLabel}
          </p>
        </div>

        {/* Coach con avatar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          <CoachAvatar url={clase.instructorFotoUrl} nombre={clase.instructorNombre} size={22} dim={esCancelada} />
          <span
            style={{
              fontSize: '12px',
              color: 'var(--sala-text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0
            }}
          >
            {clase.instructorNombre ?? 'Por confirmar'}
          </span>
        </div>

        {/* Cupos */}
        <p
          style={{
            fontSize: '12px',
            fontWeight: 600,
            margin: 0,
            marginTop: 'auto',
            paddingTop: '2px',
            fontVariantNumeric: 'tabular-nums',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            color: esCancelada
              ? 'var(--sala-text-tertiary)'
              : llena
                ? 'var(--sala-text-tertiary)'
                : pocos
                  ? 'var(--sala-accent)'
                  : ya_reservada
                    ? 'var(--sala-primary)'
                    : 'var(--sala-text-secondary)'
          }}
        >
          {esCancelada
            ? 'Cancelada'
            : llena
              ? 'Llena'
              : ya_reservada
                ? <><Check size={13} strokeWidth={2.5} /> Reservaste</>
                : pocos
                  ? `¡${clase.cupoMax - clase.cuposReservados} lugar${clase.cupoMax - clase.cuposReservados === 1 ? '' : 'es'}!`
                  : `${clase.cuposReservados}/${clase.cupoMax} cupos`}
        </p>
      </div>
    </Link>
  );
}
