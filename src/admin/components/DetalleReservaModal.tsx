import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';

interface ReservaDetalle {
  id: string;
  slot_inicio: string;
  slot_fin: string;
  status: string;
  folio: string;
  created_at: string;
  cancelada_at: string | null;
  cancelada_motivo: string | null;
  cancelada_por: string | null;
  recurso_nombre: string;
  usuario_nombre: string;
  usuario_email: string;
  tier: string | null;
}

interface Props {
  reservaId: string | null;
  onClose: () => void;
  onCancelar: (info: {
    id: string;
    slot_inicio: string;
    recurso_nombre: string;
    usuario_nombre: string;
    tier: string | null;
  }) => void;
}

function capitalizar(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatearFecha(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

function formatearHora(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

function formatearCreatedAt(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

const STATUS_LABEL: Record<string, { texto: string; color: string; icon: string }> = {
  confirmada: { texto: 'Confirmada', color: 'var(--ek-success)', icon: '✓' },
  completada: { texto: 'Completada', color: 'var(--ek-success)', icon: '✓' },
  cancelada: { texto: 'Cancelada por el miembro', color: 'var(--ek-danger)', icon: '✕' },
  cancelada_admin: { texto: 'Cancelada por admin', color: 'var(--ek-danger)', icon: '✕' },
  no_show: { texto: 'No-show', color: 'var(--ek-mustard)', icon: '⚠' }
};

export default function DetalleReservaModal({ reservaId, onClose, onCancelar }: Props) {
  const toast = useToast();
  const [data, setData] = useState<ReservaDetalle | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!reservaId) {
      setData(null);
      return;
    }
    setLoading(true);
    let mounted = true;

    supabase
      .from('reservas')
      .select(
        'id, slot_inicio, slot_fin, status, folio, created_at, cancelada_at, cancelada_motivo, cancelada_por, recurso:recursos(nombre), usuario:usuarios!reservas_usuario_id_fkey(nombre, email, membresia_tier)'
      )
      .eq('id', reservaId)
      .single()
      .then(({ data: row, error }) => {
        if (!mounted) return;
        if (error || !row) {
          toast.error(`No se pudo cargar la reserva: ${error?.message ?? 'no encontrada'}`);
          onClose();
          return;
        }
        const r = row as unknown as {
          id: string;
          slot_inicio: string;
          slot_fin: string;
          status: string;
          folio: string;
          created_at: string;
          cancelada_at: string | null;
          cancelada_motivo: string | null;
          cancelada_por: string | null;
          recurso?: { nombre?: string } | null;
          usuario?: { nombre?: string | null; email?: string; membresia_tier?: string | null } | null;
        };
        setData({
          id: r.id,
          slot_inicio: r.slot_inicio,
          slot_fin: r.slot_fin,
          status: r.status,
          folio: r.folio,
          created_at: r.created_at,
          cancelada_at: r.cancelada_at,
          cancelada_motivo: r.cancelada_motivo,
          cancelada_por: r.cancelada_por,
          recurso_nombre: r.recurso?.nombre ?? '—',
          usuario_nombre: capitalizar(r.usuario?.nombre) || r.usuario?.email || '—',
          usuario_email: r.usuario?.email ?? '—',
          tier: r.usuario?.membresia_tier ?? null
        });
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [reservaId, toast, onClose]);

  useEffect(() => {
    if (!reservaId) return;
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
  }, [reservaId, onClose]);

  if (!reservaId) return null;

  const status = data ? STATUS_LABEL[data.status] ?? { texto: data.status, color: 'var(--ek-ink-muted)', icon: '·' } : null;
  const esFutura = data ? new Date(data.slot_inicio).getTime() > Date.now() : false;
  const esConfirmada = data ? data.status === 'confirmada' : false;
  const puedeCancelar = esFutura && esConfirmada;
  const yaCancelada = data?.status === 'cancelada' || data?.status === 'cancelada_admin';

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        zIndex: 100,
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
          border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-card)',
          maxWidth: '520px',
          width: '100%',
          maxHeight: '92vh',
          overflowY: 'auto',
          padding: '28px',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '6px' }}>
          DETALLE DE RESERVA
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 700,
            margin: 0,
            marginBottom: '20px',
            letterSpacing: '-0.02em',
            color: 'var(--ek-ink-muted)'
          }}
        >
          {data ? `Folio ${data.folio}` : 'Cargando…'}
        </h3>

        {loading || !data || !status ? (
          <div className="ek-skeleton" style={{ height: '300px' }} />
        ) : (
          <>
            <Block label="MIEMBRO">
              <p style={{ fontSize: '16px', fontWeight: 600, margin: 0, marginBottom: '4px' }}>
                {data.usuario_nombre}
              </p>
              {data.tier && (
                <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '4px' }}>
                  Plan: <span style={{ color: 'var(--ek-mustard)', fontWeight: 600 }}>{data.tier}</span>
                </p>
              )}
              <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, fontFamily: 'var(--ek-font-mono)' }}>
                {data.usuario_email}
              </p>
            </Block>

            <Block label="RESERVA">
              <p style={{ fontSize: '16px', fontWeight: 600, margin: 0, marginBottom: '4px' }}>
                {data.recurso_nombre}
              </p>
              <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '4px' }}>
                {formatearFecha(data.slot_inicio).replace(/^./, (c) => c.toUpperCase())}
              </p>
              <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>
                {formatearHora(data.slot_inicio)} — {formatearHora(data.slot_fin)}
              </p>
            </Block>

            <Block label="ESTADO">
              <p
                style={{
                  fontSize: '15px',
                  fontWeight: 600,
                  margin: 0,
                  marginBottom: '4px',
                  color: status.color
                }}
              >
                {status.icon} {status.texto}
              </p>
              {yaCancelada && data.cancelada_at && (
                <>
                  <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '4px' }}>
                    Cancelada el {formatearCreatedAt(data.cancelada_at)}
                  </p>
                  {data.cancelada_motivo && (
                    <p style={{ fontSize: '13px', color: 'var(--ek-ink)', margin: '6px 0 0', lineHeight: 1.5 }}>
                      <span style={{ color: 'var(--ek-ink-muted)' }}>Motivo:</span> {data.cancelada_motivo}
                    </p>
                  )}
                </>
              )}
              {!yaCancelada && (
                <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0 }}>
                  Reservada el {formatearCreatedAt(data.created_at)}
                </p>
              )}
            </Block>

            <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
              <button
                type="button"
                onClick={onClose}
                className="ek-cta ek-cta--secondary"
                style={{ flex: 1 }}
              >
                Cerrar
              </button>
              {puedeCancelar && (
                <button
                  type="button"
                  onClick={() =>
                    onCancelar({
                      id: data.id,
                      slot_inicio: data.slot_inicio,
                      recurso_nombre: data.recurso_nombre,
                      usuario_nombre: data.usuario_nombre,
                      tier: data.tier
                    })
                  }
                  className="ek-cta"
                  style={{
                    flex: 1,
                    background: 'var(--ek-danger-soft)',
                    color: 'var(--ek-danger)',
                    border: '0.5px solid var(--ek-danger)'
                  }}
                >
                  Cancelar reserva
                </button>
              )}
            </div>
            {esFutura && !esConfirmada && !yaCancelada && (
              <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '10px', textAlign: 'center' }}>
                Solo se pueden cancelar reservas confirmadas.
              </p>
            )}
            {!esFutura && !yaCancelada && (
              <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '10px', textAlign: 'center' }}>
                Esta reserva ya pasó. No se puede cancelar.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--ek-bg-elevated)',
        border: '0.5px solid var(--ek-line)',
        borderRadius: 'var(--ek-r-md)',
        padding: '14px 16px',
        marginBottom: '12px'
      }}
    >
      <p
        className="ek-eyebrow"
        style={{ fontSize: '10px', color: 'var(--ek-mustard)', marginBottom: '8px' }}
      >
        {label}
      </p>
      {children}
    </div>
  );
}
