import { useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';

interface Props {
  usuarioId: string;
  nombreMiembro: string;
  bloqueadoHasta: Date | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

function addDays(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const PRESETS = [
  { label: '1 semana', days: 7 },
  { label: '2 semanas', days: 14 },
  { label: '1 mes', days: 30 }
];

export function BloquearAccesoModal({
  usuarioId,
  nombreMiembro,
  bloqueadoHasta,
  onClose,
  onSaved
}: Props) {
  const toast = useToast();
  const estaBloqueado = !!bloqueadoHasta && bloqueadoHasta > new Date();

  const [fechaHasta, setFechaHasta] = useState<string>(
    bloqueadoHasta ? bloqueadoHasta.toISOString().slice(0, 10) : addDays(new Date(), 7)
  );
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleBloquear() {
    setSaving(true);
    // Hasta el fin del día de la fecha elegida
    const hasta = new Date(fechaHasta + 'T23:59:59');
    const patch: { bloqueado_hasta: string; notas_admin?: string } = {
      bloqueado_hasta: hasta.toISOString()
    };
    // Si hay motivo, lo prepondemos a notas_admin existentes (audit-friendly)
    if (motivo.trim()) {
      const { data: actual } = await supabase
        .from('usuarios')
        .select('notas_admin')
        .eq('id', usuarioId)
        .maybeSingle();
      const previo = (actual?.notas_admin as string | null) ?? '';
      const stamp = new Date().toLocaleDateString('es-MX');
      const entry = `[${stamp}] Bloqueo hasta ${fechaHasta}: ${motivo.trim()}`;
      patch.notas_admin = previo ? `${entry}\n\n${previo}` : entry;
    }
    const { error } = await supabase
      .from('usuarios')
      .update(patch as never)
      .eq('id', usuarioId);
    setSaving(false);
    if (error) {
      toast.error('No pudimos bloquear el acceso. Probá de nuevo.');
      return;
    }
    toast.success(`Acceso de ${nombreMiembro} bloqueado hasta ${fechaHasta}.`);
    await onSaved();
    onClose();
  }

  async function handleDesbloquear() {
    setSaving(true);
    const { error } = await supabase
      .from('usuarios')
      .update({ bloqueado_hasta: null } as never)
      .eq('id', usuarioId);
    setSaving(false);
    if (error) {
      toast.error('No pudimos desbloquear el acceso. Probá de nuevo.');
      return;
    }
    toast.success(`Acceso de ${nombreMiembro} desbloqueado.`);
    await onSaved();
    onClose();
  }

  const fechaMinima = new Date().toISOString().slice(0, 10);

  return (
    <div className="ek-modal-backdrop" onClick={onClose}>
      <div className="ek-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ek-modal-handle" />
        <p
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: estaBloqueado ? 'var(--sala-success)' : 'var(--sala-accent)',
            margin: 0,
            marginBottom: '8px'
          }}
        >
          {estaBloqueado ? 'Desbloquear acceso' : 'Bloquear acceso temporal'}
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: 'var(--sala-text-primary)',
            margin: 0,
            marginBottom: '6px'
          }}
        >
          {nombreMiembro}
        </h3>

        {estaBloqueado ? (
          <>
            <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', margin: 0, marginBottom: '20px' }}>
              Actualmente bloqueado hasta{' '}
              <strong>
                {bloqueadoHasta!.toLocaleDateString('es-MX', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric'
                })}
              </strong>
              . Si desbloqueás ahora, el miembro va a poder reservar inmediatamente.
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="ek-cta ek-cta--secondary"
                style={{ flex: 1 }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleDesbloquear}
                disabled={saving}
                className="ek-cta"
                style={{ flex: 1 }}
              >
                {saving ? 'Desbloqueando…' : 'Sí, desbloquear'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, marginBottom: '20px' }}>
              El miembro no va a poder reservar nuevas clases hasta la fecha que elijas. Las reservas existentes se mantienen.
            </p>

            {/* Presets */}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
              {PRESETS.map((p) => {
                const presetFecha = addDays(new Date(), p.days);
                const active = fechaHasta === presetFecha;
                return (
                  <button
                    key={p.days}
                    type="button"
                    onClick={() => setFechaHasta(presetFecha)}
                    style={{
                      padding: '8px 14px',
                      minHeight: '36px',
                      background: active ? 'var(--sala-primary)' : 'var(--sala-surface)',
                      color: active ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)',
                      border: `1px solid ${active ? 'var(--sala-primary)' : 'var(--sala-border)'}`,
                      borderRadius: '999px',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit'
                    }}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label
                style={{
                  display: 'block',
                  fontSize: '13px',
                  color: 'var(--sala-text-secondary)',
                  marginBottom: '6px',
                  fontWeight: 500
                }}
              >
                Bloqueado hasta
              </label>
              <input
                type="date"
                value={fechaHasta}
                min={fechaMinima}
                onChange={(e) => setFechaHasta(e.target.value)}
                className="ek-input"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              />
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label
                style={{
                  display: 'block',
                  fontSize: '13px',
                  color: 'var(--sala-text-secondary)',
                  marginBottom: '6px',
                  fontWeight: 500
                }}
              >
                Motivo (opcional)
              </label>
              <input
                type="text"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Ej. Falta de pago. Comportamiento inapropiado."
                className="ek-input"
                maxLength={200}
              />
              <p style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)', margin: '6px 0 0' }}>
                Si lo escribís, queda guardado en las notas internas del miembro para auditoría.
              </p>
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="ek-cta ek-cta--secondary"
                style={{ flex: 1 }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleBloquear}
                disabled={saving}
                style={{
                  flex: 1,
                  padding: '12px 22px',
                  minHeight: '44px',
                  background: 'var(--sala-accent)',
                  color: 'var(--sala-text-on-accent)',
                  border: '1px solid var(--sala-accent)',
                  borderRadius: '14px',
                  fontFamily: 'inherit',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.6 : 1
                }}
              >
                {saving ? 'Bloqueando…' : 'Bloquear acceso'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
