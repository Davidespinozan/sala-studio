import { Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { estadoCupos, type Clase } from '@member/logic/claseAdapter';
import { CupoBar } from './CupoBar';

interface Props {
  clase: Clase;
  yaReservada: boolean;
  puedeReservar: boolean;
  reservando?: boolean;
  onReservar: () => void;
  onCancelar?: () => void;
}

/**
 * Tarjeta de clase del socio. Distribución densa y visual:
 *  [ foto de la sala ]  disciplina · clase · coach (avatar) · cupo  [ hora / Reservar ]
 * Sin aire muerto: la foto manda a la izquierda, la info se apila compacta y la
 * hora + acción viven juntas a la derecha.
 */
export function ClaseRow({
  clase,
  yaReservada,
  puedeReservar,
  reservando,
  onReservar,
  onCancelar
}: Props) {
  const navigate = useNavigate();
  const esCancelada = clase.status === 'cancelada';
  const estado = estadoCupos(clase);
  const llena = estado === 'llena';
  const pocos = estado === 'pocos';
  const tieneDisciplina = !!clase.disciplina && clase.disciplina !== clase.nombre;

  const onRowClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    navigate(`/app/clase/${encodeURIComponent(clase.id)}`);
  };

  const stripe = esCancelada
    ? 'var(--sala-text-tertiary)'
    : yaReservada
      ? 'var(--sala-primary)'
      : pocos
        ? 'var(--sala-accent)'
        : 'var(--sala-border)';

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Ver detalles de ${clase.nombre}`}
      onClick={onRowClick}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).tagName !== 'BUTTON') {
          e.preventDefault();
          navigate(`/app/clase/${encodeURIComponent(clase.id)}`);
        }
      }}
      style={{
        display: 'grid',
        gridTemplateColumns: '88px minmax(0, 1fr) auto',
        gap: '14px',
        alignItems: 'stretch',
        padding: '12px',
        background: esCancelada ? 'var(--sala-bg)' : 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderLeft: `3px solid ${stripe}`,
        borderRadius: '16px',
        cursor: 'pointer',
        transition: 'border-color 0.18s ease, transform 0.12s ease, box-shadow 0.18s ease',
        boxShadow: '0 1px 3px rgba(26, 31, 28, 0.04)'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = '0 6px 18px rgba(26, 31, 28, 0.10)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = '0 1px 3px rgba(26, 31, 28, 0.04)';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      {/* Foto de la sala — grande, manda visualmente */}
      <SalaImg
        url={clase.imagenUrl}
        nombre={clase.salaNombre}
        disciplina={clase.disciplina}
        dim={esCancelada}
      />

      {/* Info: disciplina · clase · coach + cupo */}
      <div
        style={{
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: '6px'
        }}
      >
        {tieneDisciplina && (
          <p
            style={{
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--sala-primary)',
              margin: 0
            }}
          >
            {clase.disciplina}
          </p>
        )}
        <p
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '17px',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: 'var(--sala-text-primary)',
            margin: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textDecoration: esCancelada ? 'line-through' : 'none',
            opacity: esCancelada ? 0.6 : 1
          }}
        >
          {clase.nombre}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
          <CoachAvatar url={clase.instructorFotoUrl} nombre={clase.instructorNombre} dim={esCancelada} />
          <span
            style={{
              fontSize: '13px',
              color: 'var(--sala-text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0
            }}
          >
            {clase.instructorNombre ? `con ${clase.instructorNombre}` : 'Instructor por confirmar'}
          </span>
        </div>
        <div style={{ marginTop: '2px' }}>
          <CupoBar clase={clase} size="md" />
        </div>
      </div>

      {/* Hora arriba + acción abajo, juntas a la derecha */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: '8px',
          minWidth: 0
        }}
      >
        <div style={{ textAlign: 'right' }}>
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '22px',
              fontWeight: 700,
              letterSpacing: '-0.03em',
              lineHeight: 1,
              color: 'var(--sala-text-primary)',
              margin: 0,
              fontVariantNumeric: 'tabular-nums'
            }}
          >
            {clase.horaLabel}
          </p>
          <p style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)', margin: '3px 0 0' }}>
            {clase.duracionMinutos} min
          </p>
        </div>
        <ActionButton
          cancelada={esCancelada}
          yaReservada={yaReservada}
          puedeReservar={puedeReservar}
          llena={llena}
          pocos={pocos}
          reservando={!!reservando}
          onReservar={onReservar}
          onCancelar={onCancelar}
        />
      </div>
    </div>
  );
}

function ActionButton({
  cancelada,
  yaReservada,
  puedeReservar,
  llena,
  pocos,
  reservando,
  onReservar,
  onCancelar
}: {
  cancelada: boolean;
  yaReservada: boolean;
  puedeReservar: boolean;
  llena: boolean;
  pocos: boolean;
  reservando: boolean;
  onReservar: () => void;
  onCancelar?: () => void;
}) {
  const baseStyle: React.CSSProperties = {
    minHeight: '40px',
    padding: '0 16px',
    fontSize: '13px',
    fontWeight: 600,
    borderRadius: '999px',
    cursor: 'pointer',
    border: '1px solid transparent',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '5px',
    transition:
      'background 0.18s ease, border-color 0.18s ease, color 0.18s ease, transform 0.16s ease, filter 0.18s ease'
  };

  if (cancelada) {
    return (
      <button
        type="button"
        disabled
        style={{
          ...baseStyle,
          background: 'var(--sala-bg)',
          color: 'var(--sala-text-tertiary)',
          borderColor: 'var(--sala-border)',
          cursor: 'not-allowed'
        }}
      >
        Cancelada
      </button>
    );
  }

  if (yaReservada) {
    return (
      <button
        type="button"
        onClick={onCancelar}
        disabled={!onCancelar || reservando}
        style={{
          ...baseStyle,
          background: 'transparent',
          color: 'var(--sala-primary)',
          borderColor: 'var(--sala-primary)'
        }}
      >
        Reservado
        <Check size={15} strokeWidth={2.5} />
      </button>
    );
  }

  if (llena) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onReservar();
        }}
        style={{
          ...baseStyle,
          background: 'transparent',
          color: 'var(--sala-accent)',
          borderColor: 'var(--sala-accent)'
        }}
      >
        Lista de espera
      </button>
    );
  }

  if (!puedeReservar) {
    return (
      <button
        type="button"
        disabled
        title="Tu plan no incluye esta sala"
        style={{
          ...baseStyle,
          background: 'var(--sala-bg)',
          color: 'var(--sala-text-tertiary)',
          borderColor: 'var(--sala-border)',
          cursor: 'not-allowed'
        }}
      >
        Sin acceso
      </button>
    );
  }

  return (
    <button
      type="button"
      className="ek-lift"
      onClick={(e) => {
        e.stopPropagation();
        onReservar();
      }}
      disabled={reservando}
      style={{
        ...baseStyle,
        background: pocos ? 'var(--grad-accent)' : 'var(--grad-primary)',
        color: 'var(--sala-text-on-primary)',
        borderColor: pocos ? 'var(--sala-accent)' : 'var(--sala-primary)',
        boxShadow: pocos
          ? '0 4px 14px var(--sala-accent-dim), inset 0 1px 0 rgba(255, 255, 255, 0.16)'
          : '0 4px 14px var(--sala-primary-dim), inset 0 1px 0 rgba(255, 255, 255, 0.16)',
        opacity: reservando ? 0.6 : 1
      }}
    >
      {reservando ? 'Reservando…' : 'Reservar'}
    </button>
  );
}

/** Iniciales (máx 2) de un nombre, para los avatares sin foto. */
function iniciales(nombre?: string): string {
  const partes = (nombre ?? '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '?';
  return partes
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/** Avatar circular del coach. Foto si hay; si no, iniciales sobre tinte de marca. */
function CoachAvatar({ url, nombre, dim }: { url?: string; nombre?: string; dim?: boolean }) {
  const size = 30;
  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: '999px',
        flexShrink: 0,
        overflow: 'hidden',
        background: 'var(--sala-primary-light)',
        border: '1px solid var(--sala-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: dim ? 0.55 : 1
      }}
    >
      {url ? (
        <img
          src={url}
          alt={nombre ?? ''}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--sala-primary)' }}>
          {iniciales(nombre)}
        </span>
      )}
    </div>
  );
}

/** Foto grande de la sala (banner izquierdo). Foto si hay; si no, tile de marca. */
function SalaImg({
  url,
  nombre,
  disciplina,
  dim
}: {
  url?: string;
  nombre?: string;
  disciplina?: string;
  dim?: boolean;
}) {
  const label = (disciplina || nombre || '').trim();
  const inicial = label ? label[0].toUpperCase() : '';
  return (
    <div
      aria-hidden="true"
      title={nombre}
      style={{
        width: '88px',
        height: '100%',
        minHeight: '88px',
        borderRadius: '12px',
        flexShrink: 0,
        overflow: 'hidden',
        border: '1px solid var(--sala-border)',
        background:
          'linear-gradient(135deg, var(--sala-primary-light), color-mix(in srgb, var(--sala-accent) 16%, var(--sala-surface)))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: dim ? 0.55 : 1
      }}
    >
      {url ? (
        <img
          src={url}
          alt={nombre ?? ''}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <span style={{ fontSize: '26px', fontWeight: 700, color: 'var(--sala-primary)' }}>{inicial}</span>
      )}
    </div>
  );
}
