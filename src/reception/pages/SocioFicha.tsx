import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { UserX } from 'lucide-react';
import { PageHeader } from '@shared/components/PageHeader';
import { EmptyState } from '@shared/components/EmptyState';
import { RenovarMembresiaModal } from '../components/acciones/RenovarMembresiaModal';
import { CambiarPlanModal } from '../components/acciones/CambiarPlanModal';
import { RecargarCreditosModal } from '../components/acciones/RecargarCreditosModal';
import { PausarReactivarMembresiaModal } from '../components/acciones/PausarReactivarMembresiaModal';
import { AsignarPlanModal } from '../components/acciones/AsignarPlanModal';
import { useSocioFicha, type EstadoMembresia, type SocioFichaData } from '../hooks/useSocioFicha';

type ModalAccion = null | 'renovar' | 'cambiar_plan' | 'recargar' | 'pausar' | 'reactivar' | 'asignar_plan';

// ── Helpers de formato ──────────────────────────────────────────────────────
function iniciales(nombre: string | null): string {
  const t = (nombre ?? '').trim().split(/\s+/).filter(Boolean);
  if (!t.length) return '?';
  return (t[0][0] + (t[1]?.[0] ?? '')).toUpperCase();
}
function fmtFechaCorta(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}
function diasHasta(iso: string | null): number | null {
  if (!iso) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const f = new Date(iso); f.setHours(0, 0, 0, 0);
  return Math.round((f.getTime() - hoy.getTime()) / 86400000);
}
function fmtReserva(iso: string): { dia: string; hora: string } {
  const d = new Date(iso);
  const dd = diasHasta(iso);
  const dia = dd === 0 ? 'Hoy' : dd === 1 ? 'Mañana' : d.toLocaleDateString('es-MX', { weekday: 'short' });
  const hora = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  return { dia, hora };
}
const TIPO_LABEL: Record<string, string> = { tiempo: 'Por tiempo', creditos: 'Créditos', hibrido: 'Híbrido' };

// ── Config de estado (capa SEMÁNTICA — D-021, colores fijos del sistema) ─────
// Badge sobre el hero oscuro: tinte translúcido del token semántico + texto claro.
const BADGE: Record<EstadoMembresia, { label: string; dot: string; token: string }> = {
  activa:   { label: 'Membresía activa',  dot: '●', token: 'var(--sala-success)' },
  pausada:  { label: 'Membresía pausada', dot: '⏸', token: 'var(--sala-warning)' },
  vencida:  { label: 'Membresía vencida', dot: '●', token: 'var(--sala-error)' },
  sin_plan: { label: 'Sin membresía',     dot: '○', token: 'rgba(255,255,255,0.55)' },
};

export default function SocioFicha() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error, refetch } = useSocioFicha(id);

  return (
    <div className="ek-page">
      <div style={{ maxWidth: '460px', margin: '0 auto', padding: '16px 16px 40px' }}>
        <PageHeader
          eyebrow="RECEPCIÓN · FICHA DEL SOCIO"
          title="Ficha del socio"
          right={
            <Link
              to="/recepcion/socios"
              className="ek-cta ek-cta--secondary"
              style={{ fontSize: '13px', whiteSpace: 'nowrap' }}
            >
              Volver a socios
            </Link>
          }
        />

        {isLoading ? (
          <FichaSkeleton />
        ) : error || !data ? (
          <EmptyState
            icon={UserX}
            title={error ?? 'No encontramos ese socio.'}
            action={
              <Link to="/recepcion/socios" className="ek-cta ek-cta--secondary">
                Volver a socios
              </Link>
            }
          />
        ) : (
          <Ficha data={data} onAccionDone={refetch} />
        )}
      </div>
    </div>
  );
}

function AccionBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ek-cta ek-cta--secondary"
      style={{ fontSize: '12px', padding: '6px 12px' }}
    >
      {children}
    </button>
  );
}

export function Ficha({ data, onAccionDone }: { data: SocioFichaData; onAccionDone?: () => Promise<void> | void }) {
  const { socio, membresia, estado, reservas, asistencia } = data;
  const badge = BADGE[estado];
  const [modalAbierto, setModalAbierto] = useState<ModalAccion>(null);

  const socioNombre = socio.nombre ?? socio.email;
  const cerrar = () => setModalAbierto(null);
  const handleDone = async () => {
    if (onAccionDone) await onAccionDone();
  };
  const esCreditos = membresia?.tierTipo === 'creditos' || membresia?.tierTipo === 'hibrido';

  return (
    <>
      {/* HERO */}
      <div
        style={{
          background: 'var(--grad-immersive)',
          borderRadius: 'var(--ek-r-card)',
          padding: '20px',
          color: '#fff',
          marginBottom: '12px',
          boxShadow: '0 8px 24px var(--sala-primary-shadow-strong, var(--sala-primary-shadow))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {socio.avatar_url ? (
            <img
              src={socio.avatar_url}
              alt=""
              style={{ width: '64px', height: '64px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: '1px solid rgba(255,255,255,0.22)' }}
            />
          ) : (
            <div
              aria-hidden="true"
              style={{
                width: '64px', height: '64px', borderRadius: '50%', flexShrink: 0,
                background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.22)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--ek-font-display)', fontWeight: 700, fontSize: '24px',
              }}
            >
              {iniciales(socio.nombre)}
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '22px', fontWeight: 700, letterSpacing: '-0.02em', margin: 0, lineHeight: 1.1 }}>
              {socio.nombre ?? socio.email}
            </h1>
            <p style={{ fontSize: '12.5px', color: 'rgba(255,255,255,0.68)', margin: '4px 0 0' }}>
              {[socio.telefono, socio.email].filter(Boolean).join(' · ')}
            </p>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px', marginTop: '10px',
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                padding: '4px 10px', borderRadius: '999px',
                background: `color-mix(in srgb, ${badge.token} 18%, transparent)`,
                color: estado === 'sin_plan' ? 'rgba(255,255,255,0.7)' : `color-mix(in srgb, ${badge.token}, white 55%)`,
                border: `0.5px solid color-mix(in srgb, ${badge.token} 35%, transparent)`,
              }}
            >
              {badge.dot} {badge.label}
            </span>
          </div>
        </div>
      </div>

      {/* ALERTA (según estado / bloqueo) */}
      <FichaAlerta data={data} />

      {/* MEMBRESÍA */}
      <div className="ek-card ek-card--md" style={{ marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
          <span className="ek-eyebrow">MEMBRESÍA</span>
          {membresia?.tierNombre && (
            <span
              style={{
                fontSize: '10.5px', fontWeight: 700, padding: '3px 9px', borderRadius: '999px',
                background: estado === 'vencida' || estado === 'sin_plan' ? 'var(--ek-bg-elevated)' : 'var(--sala-primary-light)',
                color: estado === 'vencida' || estado === 'sin_plan' ? 'var(--sala-text-secondary)' : 'var(--sala-primary)',
              }}
            >
              {membresia.tierNombre}
            </span>
          )}
        </div>

        {!membresia || estado === 'sin_plan' ? (
          <p style={{ textAlign: 'center', color: 'var(--sala-text-tertiary)', fontSize: '13px', padding: '6px 0', margin: 0 }}>
            Sin plan activo
          </p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px' }}>
            <KV k="Estado" v={estado === 'pausada' ? 'Pausada' : estado === 'vencida' ? 'Vencida' : 'Activa'} />
            {estado === 'vencida' ? (
              <KV k="Venció" v={fmtFechaCorta(membresia.periodoFin)} />
            ) : estado === 'pausada' ? (
              <KV k="Plan" v={TIPO_LABEL[membresia.tierTipo ?? ''] ?? '—'} />
            ) : (
              <KV k="Vence" v={fmtFechaCorta(membresia.periodoFin)} />
            )}
            {(() => {
              // Créditos según tipo de plan y estado:
              //  · tiempo + vencida → "—" (no aplica; "Ilimitado" sugiere activa, "0" es falso)
              //  · tiempo (otro)    → "Ilimitado"
              //  · créditos/híbrido → N + sufijo según estado (restantes/congelados)
              const tiempo = membresia.tierTipo === 'tiempo';
              let v: string;
              let sub: string | undefined;
              if (tiempo) {
                v = estado === 'vencida' ? '—' : 'Ilimitado';
              } else {
                v = String(membresia.creditos ?? 0);
                sub = estado === 'pausada' ? 'congelados' : estado === 'activa' ? 'restantes' : undefined;
              }
              return <KV k="Créditos" v={v} sub={sub} />;
            })()}
            <KV k="Tipo" v={TIPO_LABEL[membresia.tierTipo ?? ''] ?? '—'} />
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' }}>
          {estado === 'activa' && (
            <>
              <AccionBtn onClick={() => setModalAbierto('renovar')}>Renovar</AccionBtn>
              <AccionBtn onClick={() => setModalAbierto('cambiar_plan')}>Cambiar plan</AccionBtn>
              {esCreditos && <AccionBtn onClick={() => setModalAbierto('recargar')}>Recargar créditos</AccionBtn>}
              <AccionBtn onClick={() => setModalAbierto('pausar')}>Pausar</AccionBtn>
            </>
          )}
          {estado === 'pausada' && (
            <>
              <AccionBtn onClick={() => setModalAbierto('reactivar')}>Reactivar</AccionBtn>
              <AccionBtn onClick={() => setModalAbierto('cambiar_plan')}>Cambiar plan</AccionBtn>
            </>
          )}
          {estado === 'vencida' && (
            <>
              <AccionBtn onClick={() => setModalAbierto('renovar')}>Renovar</AccionBtn>
              <AccionBtn onClick={() => setModalAbierto('cambiar_plan')}>Cambiar plan</AccionBtn>
            </>
          )}
          {estado === 'sin_plan' && (
            <AccionBtn onClick={() => setModalAbierto('asignar_plan')}>Asignar plan</AccionBtn>
          )}
        </div>
      </div>

      {/* PRÓXIMAS RESERVAS */}
      <div className="ek-card ek-card--md" style={{ marginBottom: '12px' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '9px' }}>PRÓXIMAS RESERVAS</p>
        {reservas.length === 0 ? (
          <p style={{ textAlign: 'center', color: 'var(--sala-text-tertiary)', fontSize: '13px', padding: '6px 0', margin: 0 }}>
            {estado === 'pausada'
              ? 'Sin reservas (membresía pausada)'
              : estado === 'vencida'
                ? 'Sin reservas (plan vencido)'
                : estado === 'sin_plan'
                  ? 'Sin reservas (sin membresía activa)'
                  : 'Sin reservas próximas'}
          </p>
        ) : (
          reservas.map((r, i) => {
            const f = fmtReserva(r.slot_inicio);
            return (
              <div
                key={r.id}
                style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 0', borderTop: i === 0 ? 'none' : '1px solid var(--sala-border-subtle, var(--sala-border))' }}
              >
                <div style={{ fontFamily: 'var(--ek-font-display)', fontWeight: 700, fontSize: '13.5px', minWidth: '70px' }}>
                  {f.dia} {f.hora}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '13px' }}>{r.recursoNombre ?? 'Clase'}</div>
                </div>
                <span
                  style={{
                    fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                    color: 'var(--sala-primary)', background: 'var(--sala-primary-light)', padding: '3px 8px', borderRadius: '999px',
                  }}
                >
                  Confirmada
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* ASISTENCIA */}
      <div className="ek-card ek-card--md" style={{ marginBottom: '12px' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '9px' }}>ASISTENCIA</p>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Stat n={String(asistencia.semana)} l="semana" />
          <Stat n={String(asistencia.mes)} l="mes" />
          <Stat n={asistencia.pct == null ? '—' : `${asistencia.pct}%`} l="asist." />
        </div>
      </div>

      {/* NOTAS SOBRE EL SOCIO (read-only) */}
      <div className="ek-card ek-card--md">
        <p className="ek-eyebrow" style={{ marginBottom: '9px' }}>NOTAS SOBRE EL SOCIO</p>
        {socio.notas_admin && socio.notas_admin.trim() ? (
          <p style={{ fontSize: '13.5px', lineHeight: 1.5, color: 'var(--sala-text-primary)', margin: 0, whiteSpace: 'pre-wrap' }}>
            {socio.notas_admin}
          </p>
        ) : (
          <p style={{ textAlign: 'center', color: 'var(--sala-text-tertiary)', fontSize: '13px', padding: '6px 0', margin: 0 }}>
            Sin notas todavía.
          </p>
        )}
      </div>

      {modalAbierto === 'renovar' && (
        <RenovarMembresiaModal
          isOpen
          socioId={socio.id}
          socioNombre={socioNombre}
          onClose={cerrar}
          onDone={handleDone}
        />
      )}
      {modalAbierto === 'cambiar_plan' && (
        <CambiarPlanModal
          isOpen
          socioId={socio.id}
          socioNombre={socioNombre}
          tierActualId={membresia?.tierId ?? null}
          onClose={cerrar}
          onDone={handleDone}
        />
      )}
      {modalAbierto === 'recargar' && (
        <RecargarCreditosModal
          isOpen
          socioId={socio.id}
          socioNombre={socioNombre}
          onClose={cerrar}
          onDone={handleDone}
        />
      )}
      {(modalAbierto === 'pausar' || modalAbierto === 'reactivar') && (
        <PausarReactivarMembresiaModal
          isOpen
          modo={modalAbierto === 'pausar' ? 'pausar' : 'reactivar'}
          socioId={socio.id}
          socioNombre={socioNombre}
          onClose={cerrar}
          onDone={handleDone}
        />
      )}
      {modalAbierto === 'asignar_plan' && (
        <AsignarPlanModal
          isOpen
          socioId={socio.id}
          socioNombre={socioNombre}
          onClose={cerrar}
          onDone={handleDone}
        />
      )}
    </>
  );
}

// ── Alerta contextual ───────────────────────────────────────────────────────
function FichaAlerta({ data }: { data: SocioFichaData }) {
  const { socio, membresia, estado } = data;

  // Bloqueo tiene prioridad (estado operativo crítico).
  const bloqueado = socio.bloqueado_hasta && new Date(socio.bloqueado_hasta) > new Date();
  if (bloqueado) {
    return (
      <Alerta variant="error" icon="⛔">
        <b>Bloqueado</b> — sin acceso hasta el {fmtFechaCorta(socio.bloqueado_hasta)}.
      </Alerta>
    );
  }

  if (estado === 'vencida') {
    return (
      <Alerta variant="error" icon="⛔">
        <b>Plan vencido el {fmtFechaCorta(membresia?.periodoFin ?? null)}</b> — renová para reactivar el acceso.
      </Alerta>
    );
  }
  if (estado === 'pausada') {
    return (
      <Alerta variant="warning" icon="⏸">
        <b>Membresía pausada</b> — no puede reservar hasta reactivarla.
      </Alerta>
    );
  }
  if (estado === 'sin_plan') {
    return (
      <Alerta variant="neutral" icon="○">
        <b>Sin membresía activa</b> — asignale un plan para que pueda reservar.
      </Alerta>
    );
  }
  // Activa: solo si vence pronto (≤ 5 días).
  const dias = diasHasta(membresia?.periodoFin ?? null);
  if (dias != null && dias >= 0 && dias <= 5) {
    return (
      <Alerta variant="warning" icon="⏳">
        <b>Vence en {dias === 0 ? 'hoy' : `${dias} día${dias === 1 ? '' : 's'}`}</b> — su plan termina el {fmtFechaCorta(membresia?.periodoFin ?? null)}.
      </Alerta>
    );
  }
  return null;
}

function Alerta({ variant, icon, children }: { variant: 'error' | 'warning' | 'neutral'; icon: string; children: React.ReactNode }) {
  const cfg =
    variant === 'error'
      ? { bg: 'var(--sala-error-bg)', border: 'var(--sala-error-glow)', color: 'var(--sala-error)' }
      : variant === 'warning'
        ? { bg: 'var(--sala-warning-bg)', border: 'var(--sala-warning-glow)', color: 'var(--sala-warning)' }
        : { bg: 'var(--ek-bg-elevated)', border: 'var(--sala-border)', color: 'var(--sala-text-secondary)' };
  return (
    <div
      style={{
        display: 'flex', gap: '9px', alignItems: 'flex-start',
        background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
        borderRadius: 'var(--ek-r-md)', padding: '10px 12px', marginBottom: '12px', fontSize: '13px', lineHeight: 1.45,
      }}
    >
      <span style={{ fontSize: '14px', lineHeight: 1.3 }}>{icon}</span>
      <div>{children}</div>
    </div>
  );
}

function KV({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div>
      <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--sala-text-tertiary)' }}>
        {k}
      </div>
      <div style={{ fontFamily: 'var(--ek-font-display)', fontSize: '17px', fontWeight: 700, letterSpacing: '-0.02em', marginTop: '2px' }}>
        {v}
        {sub && <span style={{ fontSize: '11px', color: 'var(--sala-text-secondary)', fontWeight: 500, fontFamily: 'var(--ek-font-body)' }}> {sub}</span>}
      </div>
    </div>
  );
}

function Stat({ n, l }: { n: string; l: string }) {
  return (
    <div style={{ flex: 1 }}>
      <div
        style={{
          textAlign: 'center',
          background: 'var(--sala-primary-light)',
          borderRadius: 'var(--ek-r-md)',
          padding: '10px 8px',
        }}
      >
        <div style={{ fontFamily: 'var(--ek-font-display)', fontSize: '19px', fontWeight: 700, color: 'var(--sala-primary)' }}>{n}</div>
        <div style={{ fontSize: '10px', color: 'var(--sala-text-tertiary)', fontWeight: 600 }}>{l}</div>
      </div>
    </div>
  );
}

function FichaSkeleton() {
  return (
    <>
      <div className="ek-skeleton" style={{ height: '108px', borderRadius: 'var(--ek-r-card)', marginBottom: '12px' }} />
      <div className="ek-skeleton" style={{ height: '120px', borderRadius: 'var(--ek-r-card)', marginBottom: '12px' }} />
      <div className="ek-skeleton" style={{ height: '90px', borderRadius: 'var(--ek-r-card)' }} />
    </>
  );
}
