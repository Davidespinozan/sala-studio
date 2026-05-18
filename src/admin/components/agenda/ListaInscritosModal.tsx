import { useEffect, useState } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { formatHora } from '@member/logic/reservaLogic';
import { estadoCupos, type Clase } from '@member/logic/claseAdapter';
import {
  useInscritosDeClase,
  marcarAsistenciaAdmin,
  marcarNoShowAdmin,
  cancelarReservaAdminQuick,
  type InscritoAdmin
} from '@admin/hooks/useInscritosDeClase';
import CardMenuDropdown from '../CardMenuDropdown';
import { AgregarMiembroManualSelector } from './AgregarMiembroManualSelector';

interface Props {
  clase: Clase;
  onClose: () => void;
}

/** Modal admin: lista de inscritos a una clase + acciones por reserva. */
export function ListaInscritosModal({ clase, onClose }: Props) {
  const { usuario: currentUser } = useAuth();
  const toast = useToast();
  const { inscritos, isLoading, refetch } = useInscritosDeClase(
    clase.recursoId,
    clase.slotInicio
  );
  const [showAgregar, setShowAgregar] = useState(false);
  const [actioningId, setActioningId] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Solo cuentan los confirmadas + completadas para el indicador de cupos
  const inscritosActivos = inscritos.filter(
    (i) => i.status === 'confirmada' || i.status === 'completada'
  );
  const cuposReservados = inscritosActivos.length;
  const cuposLibres = Math.max(0, clase.cupoMax - cuposReservados);
  const estado = estadoCupos({ ...clase, cuposReservados } as Clase);
  const llena = estado === 'llena';
  const pocos = estado === 'pocos';

  async function handleAsistencia(r: InscritoAdmin) {
    if (!currentUser) return;
    setActioningId(r.reservaId);
    const { error } = await marcarAsistenciaAdmin(r.reservaId, currentUser.id);
    setActioningId(null);
    if (error) {
      toast.error('No pudimos marcar la asistencia. Probá de nuevo.');
      return;
    }
    toast.success(`${r.nombre}: asistencia confirmada.`);
    await refetch();
  }

  async function handleNoShow(r: InscritoAdmin) {
    if (!confirm(`Marcar a ${r.nombre} como no-show?`)) return;
    setActioningId(r.reservaId);
    const { error } = await marcarNoShowAdmin(r.reservaId);
    setActioningId(null);
    if (error) {
      toast.error('No pudimos marcar la inasistencia. Probá de nuevo.');
      return;
    }
    toast.success(`${r.nombre}: marcado como no-show.`);
    await refetch();
  }

  async function handleCancelar(r: InscritoAdmin) {
    if (!confirm(`Cancelar la reserva de ${r.nombre}? Esto libera el cupo.`)) return;
    setActioningId(r.reservaId);
    const { error } = await cancelarReservaAdminQuick(r.reservaId);
    setActioningId(null);
    if (error) {
      toast.error('No pudimos cancelar la reserva. Probá de nuevo.');
      return;
    }
    toast.success(`${r.nombre}: reserva cancelada.`);
    await refetch();
  }

  const fechaFmt = clase.slotInicio.toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });

  const cupoColor = llena
    ? 'var(--sala-text-tertiary)'
    : pocos
      ? 'var(--sala-accent)'
      : 'var(--sala-primary)';

  return (
    <div className="ek-modal-backdrop" onClick={onClose}>
      <div
        className="ek-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '560px' }}
      >
        <div className="ek-modal-handle" />

        {/* Header */}
        <div style={{ marginBottom: '14px' }}>
          <p
            style={{
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--sala-primary)',
              margin: 0,
              marginBottom: '4px'
            }}
          >
            {clase.disciplina}
          </p>
          <h3
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '20px',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: 'var(--sala-text-primary)',
              margin: 0,
              marginBottom: '4px'
            }}
          >
            {clase.nombre}
          </h3>
          <p
            style={{
              fontSize: '13px',
              color: 'var(--sala-text-secondary)',
              margin: 0,
              fontVariantNumeric: 'tabular-nums',
              textTransform: 'capitalize'
            }}
          >
            {fechaFmt} · {formatHora(clase.slotInicio)} · {clase.duracionMinutos} min
          </p>
        </div>

        {/* Indicador de cupos */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            background: 'var(--sala-bg)',
            border: '1px solid var(--sala-border)',
            borderRadius: '12px',
            padding: '14px 16px',
            marginBottom: '16px'
          }}
        >
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '18px',
              fontWeight: 700,
              color: cupoColor,
              margin: 0,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.02em'
            }}
          >
            {llena ? 'Clase llena' : `${cuposReservados}/${clase.cupoMax} reservados`}
          </p>
          {!llena && (
            <p style={{ fontSize: '13px', color: cupoColor, margin: 0, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              {cuposLibres} {cuposLibres === 1 ? 'libre' : 'libres'}
            </p>
          )}
        </div>

        {/* Lista de inscritos */}
        {isLoading ? (
          <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', margin: 0 }}>
            Cargando inscritos…
          </p>
        ) : inscritos.length === 0 ? (
          <div
            style={{
              padding: '32px 16px',
              textAlign: 'center',
              background: 'var(--sala-bg)',
              border: '1px dashed var(--sala-border-strong)',
              borderRadius: '12px',
              marginBottom: '16px'
            }}
          >
            <p
              style={{
                fontSize: '11px',
                fontWeight: 700,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--sala-text-tertiary)',
                margin: 0,
                marginBottom: '6px'
              }}
            >
              Sin inscritos
            </p>
            <p style={{ fontSize: '14px', color: 'var(--sala-text-primary)', margin: 0 }}>
              Nadie reservó esta clase todavía.
            </p>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              marginBottom: '16px',
              maxHeight: '40vh',
              overflowY: 'auto'
            }}
          >
            {inscritos.map((r) => (
              <InscritoRow
                key={r.reservaId}
                inscrito={r}
                actioning={actioningId === r.reservaId}
                onAsistencia={() => handleAsistencia(r)}
                onNoShow={() => handleNoShow(r)}
                onCancelar={() => handleCancelar(r)}
              />
            ))}
          </div>
        )}

        {/* Footer: agregar manual */}
        {showAgregar ? (
          <AgregarMiembroManualSelector
            clase={clase}
            excludeUsuarioIds={inscritosActivos.map((i) => i.usuarioId)}
            onAdded={async () => {
              await refetch();
              setShowAgregar(false);
            }}
            onClose={() => setShowAgregar(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowAgregar(true)}
            disabled={llena}
            title={llena ? 'La clase está llena' : 'Agregar miembro manualmente'}
            style={{
              width: '100%',
              padding: '12px',
              minHeight: '44px',
              background: 'transparent',
              color: llena ? 'var(--sala-text-tertiary)' : 'var(--sala-primary)',
              border: `1px dashed ${llena ? 'var(--sala-border)' : 'var(--sala-primary)'}`,
              borderRadius: '12px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: llena ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit'
            }}
          >
            + Agregar miembro manualmente
          </button>
        )}

        <button
          type="button"
          onClick={onClose}
          className="ek-cta ek-cta--secondary ek-cta--full"
          style={{ marginTop: '12px' }}
        >
          Cerrar
        </button>
      </div>
    </div>
  );
}

function InscritoRow({
  inscrito,
  actioning,
  onAsistencia,
  onNoShow,
  onCancelar
}: {
  inscrito: InscritoAdmin;
  actioning: boolean;
  onAsistencia: () => void;
  onNoShow: () => void;
  onCancelar: () => void;
}) {
  const statusConfig: Record<
    InscritoAdmin['status'],
    { label: string; color: string; bg: string }
  > = {
    confirmada: {
      label: 'Confirmada',
      color: 'var(--sala-primary)',
      bg: 'var(--sala-primary-light)'
    },
    completada: {
      label: 'Asistió',
      color: 'var(--sala-success)',
      bg: 'var(--sala-success-bg)'
    },
    cancelada: {
      label: 'Cancelada',
      color: 'var(--sala-text-tertiary)',
      bg: 'var(--sala-bg)'
    },
    no_show: {
      label: 'No-show',
      color: 'var(--sala-accent)',
      bg: 'var(--sala-accent-light)'
    }
  };
  const st = statusConfig[inscrito.status];
  const planLabel =
    inscrito.planSlug === 'pro'
      ? 'Ilimitado'
      : inscrito.planSlug === 'basica'
        ? 'Drop-In'
        : '—';

  // Acciones disponibles según status
  const items: Array<{ label: string; icon: string; onClick: () => void; danger?: boolean; divider?: boolean; disabled?: boolean }> = [];
  if (inscrito.status === 'confirmada') {
    items.push(
      { label: 'Marcar asistencia', icon: '✓', onClick: onAsistencia, disabled: actioning },
      { label: 'Marcar no-show', icon: '⚠', onClick: onNoShow, disabled: actioning },
      { label: 'Cancelar reserva', icon: '🚫', onClick: onCancelar, danger: true, divider: true, disabled: actioning }
    );
  } else if (inscrito.status === 'completada') {
    items.push({ label: 'Marcar como no-show', icon: '⚠', onClick: onNoShow, danger: true, disabled: actioning });
  } else if (inscrito.status === 'no_show') {
    items.push({ label: 'Revertir a confirmada', icon: '↺', onClick: onAsistencia, disabled: actioning });
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 12px',
        background: 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderRadius: '12px',
        opacity: inscrito.status === 'cancelada' ? 0.55 : 1
      }}
    >
      <span
        style={{
          width: '36px',
          height: '36px',
          borderRadius: '50%',
          background: 'var(--sala-primary)',
          color: 'var(--sala-text-on-primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '14px',
          fontWeight: 700,
          flexShrink: 0,
          fontFamily: 'var(--ek-font-display)'
        }}
      >
        {inscrito.nombre.charAt(0).toUpperCase()}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontSize: '14px',
            fontWeight: 600,
            color: 'var(--sala-text-primary)',
            margin: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {inscrito.nombre}
        </p>
        <p
          style={{
            fontSize: '11px',
            color: 'var(--sala-text-tertiary)',
            margin: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {planLabel} · {inscrito.email}
        </p>
      </div>
      <span
        style={{
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: st.color,
          background: st.bg,
          padding: '4px 8px',
          borderRadius: '999px',
          flexShrink: 0
        }}
      >
        {st.label}
      </span>
      {items.length > 0 && <CardMenuDropdown items={items} />}
    </div>
  );
}
