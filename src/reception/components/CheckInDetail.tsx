import { useEffect, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { usePlanesDelTenant } from '@shared/hooks/usePlanesDelTenant';
import { useTenant } from '@shared/hooks/useTenant';
import { getTenantTimezone, formatHoraEnTz } from '@shared/lib/timezone';
import { esCorreoMarcador } from '@shared/lib/sinCorreo';

interface MiembroData {
  id: string;
  nombre: string | null;
  email: string;
  telefono: string | null;
  avatar_url: string | null;
  membresia_tier: string | null;
  notas_admin: string | null;
}

interface RecursoData {
  id: string;
  nombre: string;
}

interface ReservaData {
  id: string;
  folio: string;
  slot_inicio: string;
  slot_fin: string;
  duracion_min: number;
  invitados_count: number;
  /** Lugar elegido en el Mapa de Salón (ej. 'L7'); null si la sala no usa mapa. */
  lugar_id?: string | null;
}

interface StatsData {
  check_ins_hoy: number;
  check_ins_semana: number;
}

/** Estado de la membresía al momento de entrar (lo calcula el RPC de check-in). */
type MembresiaEstado = 'ok' | 'vencida' | 'congelada' | 'sin_membresia';

interface Props {
  kind: 'success' | 'error';
  miembro?: MiembroData;
  recurso?: RecursoData;
  reserva?: ReservaData;
  stats?: StatsData;
  /**
   * Estado de la membresía. Por QR siempre llega 'ok' (si no, ni se completa el
   * check-in). Por check-in MANUAL puede llegar muerta: la recepción entró con
   * criterio y la pantalla se lo tiene que decir para que cobre o avise.
   */
  membresiaEstado?: MembresiaEstado;
  errorMessage?: string;
  onClose: () => void;
}

const MEMBRESIA_AVISO: Record<Exclude<MembresiaEstado, 'ok'>, string> = {
  vencida: 'VENCIDA',
  congelada: 'PAUSADA',
  sin_membresia: 'SIN MEMBRESÍA',
};

const AUTO_CLOSE_MS = 15_000;

export function CheckInDetail({ kind, miembro, recurso, reserva, stats, membresiaEstado, errorMessage, onClose }: Props) {
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(AUTO_CLOSE_MS / 1000));
  const { nombrePlan } = usePlanesDelTenant();
  const tz = getTenantTimezone(useTenant());

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    const timeout = setTimeout(onClose, AUTO_CLOSE_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [onClose]);

  if (kind === 'error') {
    return (
      <div className="rec-detail rec-detail--error">
        <p className="rec-detail-eyebrow" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><AlertTriangle size={15} strokeWidth={2.5} />NO PUEDE ENTRAR</p>
        <p className="rec-detail-error-message">{errorMessage ?? 'QR no válido'}</p>
        <p style={{ color: 'var(--sala-text-secondary)', fontSize: '0.875rem', marginTop: '1rem' }}>
          Si necesitas anular o aclarar, avisa a admin.
        </p>
        <div className="rec-detail-footer">
          <button onClick={onClose} className="ek-cta ek-cta--full">
            Entendido
          </button>
          <p style={{ fontSize: '0.75rem', color: 'var(--sala-text-tertiary)', marginTop: '0.5rem' }}>
            Cierra en {secondsLeft}s
          </p>
        </div>
      </div>
    );
  }

  if (!miembro || !recurso || !reserva) return null;

  const hora = (iso: string) => formatHoraEnTz(new Date(iso), tz);

  // El nombre REAL del plan del socio. Antes esto comparaba contra los slugs de
  // los planes de ejemplo del onboarding ('pro' / 'basica'), así que en un gym
  // cuyos planes se llaman "Mensual" o "Anual" TODO socio con membresía activa
  // salía como "SIN PLAN" — y a un "sin plan" la recepción lo rebota en la puerta.
  const nombre = nombrePlan(miembro.membresia_tier);
  const tierLabel = nombre ?? 'SIN PLAN';
  const tierColor = nombre ? 'var(--sala-primary)' : 'var(--sala-text-secondary)';

  // Membresía muerta que igual entró (solo pasa por check-in manual). No es un
  // "SIN PLAN" cosmético: es una entrada que la recepción autorizó a mano y que
  // probablemente haya que cobrar. Va en rojo, aparte, para que no pase de largo.
  const membresiaMuerta =
    membresiaEstado && membresiaEstado !== 'ok' ? MEMBRESIA_AVISO[membresiaEstado] : null;

  return (
    <div className="rec-detail rec-detail--success">
      <p className="rec-detail-eyebrow" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Check size={15} strokeWidth={2.5} />CHECK-IN OK</p>

      <div className="rec-detail-header">
        <Avatar nombre={miembro.nombre ?? miembro.email} url={miembro.avatar_url} />
        <div>
          <h2 className="rec-detail-name">{miembro.nombre ?? '—'}</h2>
          <p className="rec-detail-contact">
            {esCorreoMarcador(miembro.email)
              ? <span style={{ color: 'var(--ek-warning, #d97706)', fontWeight: 700 }}>⚠ Sin correo — pídele su email</span>
              : miembro.email}
          </p>
          {miembro.telefono && <p className="rec-detail-contact">{miembro.telefono}</p>}
        </div>
      </div>

      <div className="rec-detail-divider" />

      <div className="rec-detail-grid">
        <Cell label="SALA" value={recurso.nombre} />
        <Cell label="HORA" value={`${hora(reserva.slot_inicio)} – ${hora(reserva.slot_fin)}`} />
        <Cell label="DURACIÓN" value={`${reserva.duracion_min} min`} />
        <Cell label="FOLIO" value={reserva.folio} mono />
        <Cell label="PERSONAS" value={`${1 + reserva.invitados_count}`} />
        {reserva.lugar_id && (
          <Cell label="LUGAR" value={reserva.lugar_id.replace(/^L/i, '')} color="var(--sala-primary)" />
        )}
      </div>

      <div className="rec-detail-divider" />

      <div className="rec-detail-grid">
        <Cell
          label="MEMBRESÍA"
          value={membresiaMuerta ? `${tierLabel} · ${membresiaMuerta}` : tierLabel}
          color={membresiaMuerta ? 'var(--sala-error)' : tierColor}
        />
        <Cell label="CHECK-IN HOY" value={`${stats?.check_ins_hoy ?? 1}`} />
        <Cell label="CHECK-IN SEMANA" value={`${stats?.check_ins_semana ?? 1}`} />
      </div>

      {membresiaMuerta && (
        <div
          style={{
            display: 'flex',
            gap: '8px',
            marginTop: '10px',
            padding: '10px 12px',
            borderRadius: 'var(--ek-r-card)',
            border: '1px solid var(--sala-error)',
            background: 'var(--sala-surface)',
          }}
        >
          <AlertTriangle size={16} strokeWidth={2} style={{ color: 'var(--sala-error)', flexShrink: 0, marginTop: '1px' }} />
          <p style={{ margin: 0, fontSize: '12.5px', lineHeight: 1.5 }}>
            Entró con la membresía <strong>{membresiaMuerta.toLowerCase()}</strong>. Si corresponde,
            cobrale la renovación en caja.
          </p>
        </div>
      )}

      {miembro.notas_admin && (
        <>
          <div className="rec-detail-divider" />
          <div>
            <p className="rec-detail-section-label">NOTAS DEL MIEMBRO</p>
            <p className="rec-detail-notas">{miembro.notas_admin}</p>
          </div>
        </>
      )}

      <div className="rec-detail-footer">
        <button onClick={onClose} className="ek-cta ek-cta--full">
          Listo
        </button>
        <p style={{ fontSize: '0.75rem', color: 'var(--sala-text-tertiary)', marginTop: '0.5rem' }}>
          Cierra en {secondsLeft}s
        </p>
      </div>
    </div>
  );
}

function Cell({ label, value, mono, color }: { label: string; value: string; mono?: boolean; color?: string }) {
  return (
    <div>
      <p className="rec-detail-section-label">{label}</p>
      <p
        className="rec-detail-value"
        style={{
          fontFamily: mono ? 'var(--ek-font-mono)' : 'inherit',
          color: color ?? 'var(--ek-ink)'
        }}
      >
        {value}
      </p>
    </div>
  );
}

function Avatar({ nombre, url }: { nombre: string; url: string | null }) {
  const [failed, setFailed] = useState(false);
  const initials = nombre
    .split(/[\s@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  if (url && !failed) {
    return <img src={url} alt={nombre} className="rec-detail-avatar" onError={() => setFailed(true)} />;
  }
  return (
    <div className="rec-detail-avatar rec-detail-avatar--initials">
      {initials || '?'}
    </div>
  );
}
