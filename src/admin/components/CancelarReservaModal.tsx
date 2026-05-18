import { useEffect, useState } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { cancelarReserva } from '../lib/crudHelpers';

export interface ReservaParaCancelar {
  id: string;
  slot_inicio: string;
  recurso_nombre: string;
  usuario_nombre: string;
  tier?: string | null;
}

interface Props {
  reserva: ReservaParaCancelar;
  onClose: () => void;
  onCancelled: () => void;
}

function formatearFecha(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function primerNombre(nombre: string): string {
  return nombre.split(/\s+/).filter(Boolean)[0] ?? nombre;
}

export default function CancelarReservaModal({ reserva, onClose, onCancelled }: Props) {
  const { usuario } = useAuth();
  const toast = useToast();

  const [motivo, setMotivo] = useState('');
  const [notificarMiembro, setNotificarMiembro] = useState(true);
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, submitting]);

  const fechaFmt = formatearFecha(reserva.slot_inicio);
  const motivoOk = motivo.trim().length >= 5;
  const typedOk = typed === 'CANCELAR';
  const canSubmit = motivoOk && typedOk && !submitting;

  const mensajeWhatsapp = `Hola ${primerNombre(reserva.usuario_nombre)}, te aviso que tuvimos que cancelar tu reserva del ${fechaFmt} en ${reserva.recurso_nombre}. Motivo: ${motivo || '[escribe el motivo arriba]'}. Disculpa las molestias, podés reservar otra fecha desde la app.`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(mensajeWhatsapp);
      setCopiado(true);
      toast.success('Mensaje copiado.');
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      toast.error('No se pudo copiar.');
    }
  }

  async function handleSubmit() {
    if (!usuario) return;
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    const { error: err } = await cancelarReserva({
      reservaId: reserva.id,
      motivo: motivo.trim(),
      canceladoPorId: usuario.id,
      notificarMiembro
    });

    if (err) {
      setError(err);
      toast.error(`No se pudo cancelar: ${err}`);
      setSubmitting(false);
      return;
    }

    toast.success('Reserva cancelada.');
    onCancelled();
    onClose();
  }

  return (
    <div
      onClick={() => !submitting && onClose()}
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        zIndex: 110,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        animation: 'ek-fade-in 0.18s ease'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-danger)',
          borderRadius: 'var(--ek-r-card)',
          maxWidth: '560px',
          width: '100%',
          maxHeight: '92vh',
          overflowY: 'auto',
          padding: '28px',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p className="ek-eyebrow" style={{ color: 'var(--ek-danger)', marginBottom: '6px' }}>
          CANCELAR RESERVA
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 700,
            margin: 0,
            marginBottom: '8px',
            letterSpacing: '-0.02em'
          }}
        >
          Estás cancelando esta reserva
        </h3>

        <div
          style={{
            background: 'var(--ek-bg-elevated)',
            border: '0.5px solid var(--ek-line)',
            borderRadius: 'var(--ek-r-md)',
            padding: '14px 16px',
            marginBottom: '20px'
          }}
        >
          <p style={{ fontSize: '14px', fontWeight: 600, margin: 0, marginBottom: '4px' }}>
            {reserva.usuario_nombre}
            {reserva.tier && (
              <span style={{ color: 'var(--ek-ink-muted)', fontWeight: 400 }}> · {reserva.tier}</span>
            )}
          </p>
          <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>
            {reserva.recurso_nombre} · {fechaFmt}
          </p>
        </div>

        <div className="ek-form-field" style={{ marginBottom: '14px' }}>
          <label className="ek-label">Motivo de la cancelación *</label>
          <input
            type="text"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            className="ek-input"
            placeholder="Ej. Mantenimiento del estudio"
            required
            minLength={5}
            disabled={submitting}
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Este motivo se compartirá con el miembro.
          </p>
        </div>

        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            padding: '12px',
            border: '0.5px solid var(--ek-line)',
            borderRadius: 'var(--ek-r-md)',
            background: 'var(--ek-bg-elevated)',
            marginBottom: '20px',
            cursor: 'pointer'
          }}
        >
          <input
            type="checkbox"
            checked={notificarMiembro}
            onChange={(e) => setNotificarMiembro(e.target.checked)}
            disabled={submitting}
            style={{ marginTop: '3px', accentColor: 'var(--ek-mustard)' }}
          />
          <div>
            <p style={{ fontSize: '14px', fontWeight: 500, margin: 0, marginBottom: '2px' }}>
              Notificar al miembro
            </p>
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0 }}>
              Aparecerá una notificación cuando entre a su app.
            </p>
          </div>
        </label>

        <div
          style={{
            background: 'var(--ek-mustard-soft)',
            border: '0.5px solid var(--ek-mustard-dim)',
            borderRadius: 'var(--ek-r-md)',
            padding: '14px 16px',
            marginBottom: '20px'
          }}
        >
          <p
            className="ek-eyebrow ek-eyebrow--mustard"
            style={{ fontSize: '10px', marginBottom: '8px' }}
          >
            💡 SUGERENCIA WHATSAPP
          </p>
          <p
            style={{
              fontSize: '13px',
              color: 'var(--ek-ink)',
              lineHeight: 1.55,
              margin: 0,
              marginBottom: '10px',
              fontFamily: 'var(--ek-font-mono)',
              background: 'var(--ek-bg)',
              padding: '10px 12px',
              borderRadius: 'var(--ek-r-sm)'
            }}
          >
            {mensajeWhatsapp}
          </p>
          <button
            type="button"
            onClick={handleCopy}
            className="ek-icon-btn"
            style={{ width: 'auto', padding: '8px 14px', fontSize: '12px' }}
          >
            {copiado ? '✓ Copiado' : '📋 Copiar mensaje'}
          </button>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', marginBottom: '6px' }}>
            Escribí <strong style={{ color: 'var(--ek-ink)' }}>CANCELAR</strong> para confirmar:
          </p>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="ek-input"
            placeholder="CANCELAR"
            style={{ fontFamily: 'var(--ek-font-mono)' }}
            disabled={submitting}
          />
        </div>

        {error && <p className="ek-error-text" style={{ marginBottom: '12px' }}>{error}</p>}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            Volver
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="ek-cta"
            style={{
              flex: 1,
              background: 'var(--ek-danger-soft)',
              color: 'var(--ek-danger)',
              border: '0.5px solid var(--ek-danger)',
              opacity: canSubmit ? 1 : 0.5
            }}
          >
            {submitting ? 'Cancelando…' : 'Cancelar reserva'}
          </button>
        </div>
      </div>
    </div>
  );
}
