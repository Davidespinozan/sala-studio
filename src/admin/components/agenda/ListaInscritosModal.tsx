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
import { useEditarCancelarClase } from '@admin/hooks/useEditarCancelarClase';
import CardMenuDropdown from '../CardMenuDropdown';
import ConfirmDialog from '../ConfirmDialog';
import { AgregarMiembroManualSelector } from './AgregarMiembroManualSelector';
import { EditarClaseModal } from './EditarClaseModal';

interface Props {
  clase: Clase;
  onClose: () => void;
}

/** Modal admin: lista de inscritos a una clase + acciones por reserva.
 *  S4.3: agrega editar y cancelar la clase puntual. */
export function ListaInscritosModal({ clase, onClose }: Props) {
  const { usuario: currentUser } = useAuth();
  const toast = useToast();
  // claseActual: copia local que se actualiza si el admin edita la clase.
  const [claseActual, setClaseActual] = useState<Clase>(clase);
  const { inscritos, isLoading, refetch } = useInscritosDeClase(claseActual.id);
  const { cancelarClase, cancelling } = useEditarCancelarClase(claseActual.id);
  const [showAgregar, setShowAgregar] = useState(false);
  const [showEditar, setShowEditar] = useState(false);
  const [showCancelarClase, setShowCancelarClase] = useState(false);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<
    { kind: 'noShow' | 'cancelar'; inscrito: InscritoAdmin } | null
  >(null);

  const esCancelada = claseActual.status === 'cancelada';

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
  const cuposLibres = Math.max(0, claseActual.cupoMax - cuposReservados);
  const estado = estadoCupos({ ...claseActual, cuposReservados } as Clase);
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

  function handleNoShow(r: InscritoAdmin) {
    setConfirmTarget({ kind: 'noShow', inscrito: r });
  }

  function handleCancelar(r: InscritoAdmin) {
    setConfirmTarget({ kind: 'cancelar', inscrito: r });
  }

  async function ejecutarConfirmTarget() {
    if (!confirmTarget) return;
    const { kind, inscrito } = confirmTarget;
    setActioningId(inscrito.reservaId);
    const { error } =
      kind === 'noShow'
        ? await marcarNoShowAdmin(inscrito.reservaId)
        : await cancelarReservaAdminQuick(inscrito.reservaId);
    setActioningId(null);
    setConfirmTarget(null);
    if (error) {
      toast.error(
        kind === 'noShow'
          ? 'No pudimos marcar la inasistencia. Probá de nuevo.'
          : 'No pudimos cancelar la reserva. Probá de nuevo.'
      );
      return;
    }
    toast.success(
      kind === 'noShow'
        ? `${inscrito.nombre}: marcado como no-show.`
        : `${inscrito.nombre}: reserva cancelada.`
    );
    await refetch();
  }

  async function handleCancelarClase() {
    const { error } = await cancelarClase();
    if (error) {
      toast.error('No pudimos cancelar la clase. Probá de nuevo.');
      return;
    }
    toast.success('Clase cancelada');
    setShowCancelarClase(false);
    onClose();
  }

  const fechaFmt = claseActual.slotInicio.toLocaleDateString('es-MX', {
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
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: '12px',
            marginBottom: '14px'
          }}
        >
          <div style={{ minWidth: 0 }}>
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
              {claseActual.disciplina}
            </p>
            <h3
              style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '20px',
                fontWeight: 600,
                letterSpacing: '-0.02em',
                color: 'var(--sala-text-primary)',
                margin: 0,
                marginBottom: '4px',
                textDecoration: esCancelada ? 'line-through' : 'none',
                opacity: esCancelada ? 0.6 : 1
              }}
            >
              {claseActual.nombre}
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
              {fechaFmt} · {formatHora(claseActual.slotInicio)} · {claseActual.duracionMinutos} min
            </p>
            <p
              style={{
                fontSize: '12px',
                color: 'var(--sala-text-tertiary)',
                margin: '2px 0 0'
              }}
            >
              {claseActual.instructorNombre
                ? `Instructor: ${claseActual.instructorNombre}`
                : 'Sin instructor asignado'}
            </p>
          </div>
          {!esCancelada && (
            <button
              type="button"
              onClick={() => setShowEditar(true)}
              className="ek-icon-btn"
              style={{ width: 'auto', padding: '8px 14px', fontSize: '12px', flexShrink: 0 }}
            >
              ✏️ Editar
            </button>
          )}
        </div>

        {/* Banner clase cancelada */}
        {esCancelada && (
          <div
            style={{
              background: 'var(--sala-error-bg)',
              border: '1px solid rgba(196, 74, 53, 0.30)',
              borderRadius: '12px',
              padding: '12px 14px',
              marginBottom: '16px'
            }}
          >
            <p
              style={{
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--sala-error)',
                margin: 0,
                marginBottom: '4px'
              }}
            >
              Clase cancelada
            </p>
            <p style={{ fontSize: '13px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.5 }}>
              {claseActual.canceladaAt
                ? `Cancelada el ${new Date(claseActual.canceladaAt).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' })}. `
                : ''}
              Los inscritos siguen registrados pero no asistirán.
            </p>
          </div>
        )}

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
            {llena ? 'Clase llena' : `${cuposReservados}/${claseActual.cupoMax} reservados`}
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

        {/* Footer: agregar manual (oculto si la clase está cancelada) */}
        {!esCancelada && (
          showAgregar ? (
            <AgregarMiembroManualSelector
              clase={claseActual}
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
          )
        )}

        <button
          type="button"
          onClick={onClose}
          className="ek-cta ek-cta--secondary ek-cta--full"
          style={{ marginTop: '12px' }}
        >
          Cerrar
        </button>

        {/* Cancelar clase — separado, destructivo, solo si no está ya cancelada */}
        {!esCancelada && (
          <button
            type="button"
            onClick={() => setShowCancelarClase(true)}
            style={{
              width: '100%',
              marginTop: '10px',
              padding: '10px 16px',
              minHeight: '40px',
              background: 'transparent',
              color: 'var(--sala-error)',
              border: '1px solid var(--sala-error)',
              borderRadius: '12px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit'
            }}
          >
            Cancelar clase
          </button>
        )}
      </div>

      {showEditar && (
        <EditarClaseModal
          clase={claseActual}
          inscritosActivos={cuposReservados}
          onClose={() => setShowEditar(false)}
          onSaved={async (patch) => {
            setClaseActual((c) => ({
              ...c,
              nombre: patch.nombre,
              descripcion: patch.descripcion ?? undefined,
              cupoMax: patch.cupo_max,
              duracionMinutos: patch.duracion_minutos
            }));
            await refetch();
          }}
        />
      )}

      <ConfirmDialog
        isOpen={showCancelarClase}
        variant="danger"
        title="¿Cancelar esta clase?"
        description={`Se cancelará la clase del ${fechaFmt} a las ${formatHora(claseActual.slotInicio)}. Los ${cuposReservados} inscritos verán el cambio cuando abran la app. Esta acción no se puede deshacer.`}
        confirmLabel={cancelling ? 'Cancelando…' : 'Sí, cancelar clase'}
        cancelLabel="Volver"
        onConfirm={handleCancelarClase}
        onCancel={() => !cancelling && setShowCancelarClase(false)}
      />

      <ConfirmDialog
        isOpen={!!confirmTarget}
        variant={confirmTarget?.kind === 'cancelar' ? 'danger' : 'warning'}
        title={
          confirmTarget?.kind === 'cancelar'
            ? `¿Cancelar la reserva de ${confirmTarget.inscrito.nombre}?`
            : '¿Marcar como no-show?'
        }
        description={
          confirmTarget?.kind === 'cancelar'
            ? 'El cupo se libera automáticamente.'
            : confirmTarget
              ? `${confirmTarget.inscrito.nombre} no asistió. Esta acción se registra en historial.`
              : ''
        }
        confirmLabel={
          confirmTarget?.kind === 'cancelar' ? 'Sí, cancelar reserva' : 'Sí, marcar no-show'
        }
        onConfirm={ejecutarConfirmTarget}
        onCancel={() => actioningId === null && setConfirmTarget(null)}
      />
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
