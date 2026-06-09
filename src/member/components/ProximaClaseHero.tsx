import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { type Clase } from '@member/logic/claseAdapter';

interface Props {
  clase: Clase;
  reservaId: string;
}

/** Card hero del Home con la próxima clase reservada del miembro.
 *  Banda lateral salvia + degradé suave + 2 CTAs (Ver detalle + Mi QR). */
export function ProximaClaseHero({ clase, reservaId }: Props) {
  return (
    <div
      style={{
        position: 'relative',
        background: 'linear-gradient(135deg, var(--sala-surface) 0%, var(--sala-primary-light) 100%)',
        border: '1px solid var(--sala-border)',
        borderRadius: '20px',
        padding: '24px',
        paddingLeft: '28px',
        boxShadow: '0 4px 16px rgba(26, 31, 28, 0.06)',
        overflow: 'hidden'
      }}
    >
      {/* Banda lateral salvia */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: '4px',
          background: 'var(--sala-primary)',
          borderRadius: '20px 0 0 20px'
        }}
      />

      <p
        style={{
          fontSize: '11px',
          fontWeight: 700,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--sala-primary)',
          margin: 0,
          marginBottom: '10px'
        }}
      >
        Tu próxima clase
      </p>

      <h2
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(26px, 6vw, 32px)',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          lineHeight: 1.1,
          margin: 0,
          marginBottom: '8px',
          color: 'var(--sala-text-primary)'
        }}
      >
        {clase.nombre}
      </h2>

      <p
        style={{
          fontSize: '15px',
          fontWeight: 500,
          color: 'var(--sala-text-secondary)',
          margin: 0,
          marginBottom: '4px',
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {clase.horaHumanaLabel}
      </p>

      <p
        style={{
          fontSize: '13px',
          color: 'var(--sala-text-tertiary)',
          margin: 0,
          marginBottom: '20px'
        }}
      >
        {clase.instructorNombre ? `con ${clase.instructorNombre}` : 'Instructor por confirmar'}
        {clase.salaNombre && clase.salaNombre !== clase.nombre && ` · ${clase.salaNombre}`}
      </p>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <Link
          to={`/app/clase/${encodeURIComponent(clase.id)}`}
          style={{
            padding: '10px 18px',
            minHeight: '40px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '999px',
            background: 'var(--sala-surface)',
            color: 'var(--sala-text-primary)',
            border: '1px solid var(--sala-border-strong)',
            fontSize: '13px',
            fontWeight: 600,
            textDecoration: 'none'
          }}
        >
          Ver detalle
        </Link>
        <Link
          to={`/app/qr/${reservaId}`}
          style={{
            padding: '10px 22px',
            minHeight: '40px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '999px',
            background: 'var(--sala-primary)',
            color: 'var(--sala-text-on-primary)',
            border: '1px solid var(--sala-primary)',
            fontSize: '13px',
            fontWeight: 600,
            textDecoration: 'none',
            boxShadow: '0 2px 8px rgba(61, 107, 82, 0.16)',
            gap: '6px'
          }}
        >
          Mi QR
          <ArrowRight size={16} strokeWidth={2.25} />
        </Link>
      </div>
    </div>
  );
}
