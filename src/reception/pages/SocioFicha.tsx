import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { UserX } from 'lucide-react';
import { PageHeader } from '@shared/components/PageHeader';
import { EmptyState } from '@shared/components/EmptyState';
import { RenovarMembresiaModal } from '../components/acciones/RenovarMembresiaModal';
import { CrearReservaModal } from '../components/acciones/CrearReservaModal';
import { CambiarPlanModal } from '../components/acciones/CambiarPlanModal';
import { RecargarCreditosModal } from '../components/acciones/RecargarCreditosModal';
import { PausarReactivarMembresiaModal } from '../components/acciones/PausarReactivarMembresiaModal';
import { AsignarPlanModal } from '../components/acciones/AsignarPlanModal';
import { CancelarMembresiaModal } from '../components/acciones/CancelarMembresiaModal';
import { BloquearSocioModal } from '../components/acciones/BloquearSocioModal';
import { DesbloquearSocioModal } from '../components/acciones/DesbloquearSocioModal';
import { AgregarNotaModal } from '../components/acciones/AgregarNotaModal';
import { EditarContactoModal } from '../components/acciones/EditarContactoModal';
import { EnviarAvisoModal } from '../components/acciones/EnviarAvisoModal';
import { ResetPasswordModal } from '../components/acciones/ResetPasswordModal';
import { CrearAccesoSocioModal } from '../components/acciones/CrearAccesoSocioModal';
import { HuellaModal } from '../components/acciones/HuellaModal';
import { Avatar } from '@shared/components/Avatar';
import { HistorialPagosSocio } from '@shared/components/HistorialPagosSocio';
import { MetodoPagoMembresia } from '@shared/components/MetodoPagoMembresia';
import { useSocioFicha, type EstadoMembresia, type SocioFichaData, type FichaHistorialReserva } from '../hooks/useSocioFicha';
import { useSocioNotas } from '../hooks/useSocioNotas';
import { useHuellasSocio } from '@shared/hooks/useHuellasSocio';
import { useMultasSocio, type MultaPendiente } from '../hooks/useMultasSocio';
import { cobrarMultaReserva, marcarAsistioReserva } from '../hooks/useReservasHoy';
import { formatearMoneda } from '@shared/lib/dinero';
import { useToast } from '@shared/hooks/useToast';
import { useTenant } from '@shared/hooks/useTenant';
import { getTenantTimezone, hoyEnTimezone, fechaEnTz, formatHoraEnTz, diasEntre } from '@shared/lib/timezone';

type ModalAccion =
  | null
  | 'crear_reserva'
  | 'renovar'
  | 'cambiar_plan'
  | 'recargar'
  | 'pausar'
  | 'reactivar'
  | 'asignar_plan'
  | 'cancelar_membresia'
  | 'bloquear'
  | 'desbloquear'
  | 'agregar_nota'
  | 'editar_contacto'
  | 'enviar_aviso'
  | 'reset_password'
  | 'crear_acceso'
  | 'huella';

// ── Helpers de formato ──────────────────────────────────────────────────────
/** Una multa pendiente en la ficha: monto + falta + método + cobrar (a la Caja). */
function MultaRow({ multa, onCobrada }: { multa: MultaPendiente; onCobrada: () => Promise<void> }) {
  const toast = useToast();
  const [metodo, setMetodo] = useState<'efectivo' | 'tarjeta' | 'transferencia'>('efectivo');
  const [cobrando, setCobrando] = useState(false);

  async function cobrar() {
    setCobrando(true);
    try {
      await cobrarMultaReserva(multa.id, metodo);
      toast.success(`Multa de ${formatearMoneda(multa.multa_centavos)} cobrada.`);
      await onCobrada();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cobrar la multa');
      setCobrando(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: '140px' }}>
        <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: 'var(--sala-text-primary)' }}>
          {formatearMoneda(multa.multa_centavos)}
        </p>
        <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--sala-text-tertiary)' }}>
          Faltó · {fmtFechaCorta(multa.slot_inicio)}
          {multa.recurso_nombre ? ` · ${multa.recurso_nombre}` : ''}
        </p>
      </div>
      <select
        value={metodo}
        onChange={(e) => setMetodo(e.target.value as 'efectivo' | 'tarjeta' | 'transferencia')}
        className="ek-input"
        style={{ width: 'auto', fontSize: '13px' }}
        disabled={cobrando}
      >
        <option value="efectivo">Efectivo</option>
        <option value="tarjeta">Tarjeta</option>
        <option value="transferencia">Transferencia</option>
      </select>
      <button
        type="button"
        onClick={cobrar}
        disabled={cobrando}
        className="ek-cta"
        style={{ fontSize: '13px' }}
      >
        {cobrando ? 'Cobrando…' : 'Cobrar'}
      </button>
    </div>
  );
}

function fmtFechaCorta(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  // Muestra el año si NO es el actual: así una membresía vencida hace un año
  // ("2 sep 2025") no se confunde con una reciente.
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('es-MX', opts);
}
function diasHasta(iso: string | null): number | null {
  if (!iso) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const f = new Date(iso); f.setHours(0, 0, 0, 0);
  return Math.round((f.getTime() - hoy.getTime()) / 86400000);
}
// Día y hora de una reserva en la zona del GYM (no del navegador): si la
// recepción se ve desde otra zona horaria, siguen siendo los del gym.
function fmtReserva(iso: string, tz: string, hoyISO: string): { dia: string; hora: string } {
  const diaISO = fechaEnTz(new Date(iso), tz);
  const dd = diasEntre(hoyISO, diaISO);
  let dia: string;
  if (dd === 0) dia = 'Hoy';
  else if (dd === 1) dia = 'Mañana';
  else {
    const [y, m, d] = diaISO.split('-').map(Number);
    dia = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('es-MX', { weekday: 'short', timeZone: 'UTC' });
  }
  const hora = formatHoraEnTz(new Date(iso), tz);
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

const HIST_STATUS: Record<FichaHistorialReserva['status'], { label: string; color: string; bg: string }> = {
  completada: { label: 'Asistió', color: 'var(--sala-success)', bg: 'var(--sala-primary-light)' },
  no_show: { label: 'No-show', color: 'var(--sala-accent)', bg: 'var(--sala-accent-light)' },
  cancelada: { label: 'Cancelada', color: 'var(--sala-text-tertiary)', bg: 'var(--sala-bg)' },
  cancelada_admin: { label: 'Cancelada', color: 'var(--sala-text-tertiary)', bg: 'var(--sala-bg)' }
};

export function Ficha({ data, onAccionDone }: { data: SocioFichaData; onAccionDone?: () => Promise<void> | void }) {
  const { socio, membresia, estado, reservas, historial, asistencia, invitadosBolsa } = data;
  const tz = getTenantTimezone(useTenant());
  const hoyISO = hoyEnTimezone(tz);
  const badge = BADGE[estado];
  const toast = useToast();
  const [modalAbierto, setModalAbierto] = useState<ModalAccion>(null);
  const [corrigiendo, setCorrigiendo] = useState<string | null>(null);

  async function marcarAsistio(reservaId: string) {
    setCorrigiendo(reservaId);
    try {
      await marcarAsistioReserva(reservaId);
      if (onAccionDone) await onAccionDone();
      toast.success('Asistencia corregida a "presente".');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo corregir la asistencia.');
    } finally {
      setCorrigiendo(null);
    }
  }

  const socioNombre = socio.nombre ?? socio.email;
  const { notas, refetch: refetchNotas } = useSocioNotas(socio.id);
  const { huellas, refetch: refetchHuellas } = useHuellasSocio(socio.id);
  const { multas, refetch: refetchMultas } = useMultasSocio(socio.id);
  const [pagosReload, setPagosReload] = useState(0);
  const cerrar = () => setModalAbierto(null);
  const handleDone = async () => {
    if (onAccionDone) await onAccionDone();
    await refetchNotas();
    await refetchHuellas();
    // Tras cualquier acción (incluye cobros) refrescamos el historial de pagos:
    // el cobro recién hecho aparece arriba con su botón de Recibo.
    setPagosReload((n) => n + 1);
  };
  const esCreditos = membresia?.tierTipo === 'creditos' || membresia?.tierTipo === 'hibrido';
  const bloqueado = !!socio.bloqueado_hasta && new Date(socio.bloqueado_hasta) > new Date();

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
          <Avatar
            src={socio.avatar_url}
            nombre={socio.nombre}
            email={socio.email}
            size={64}
            fallbackBg="rgba(255,255,255,0.14)"
            fallbackColor="#fff"
            style={{ border: '1px solid rgba(255,255,255,0.22)' }}
          />
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

      {/* ACCIONES DEL SOCIO (gobernanza: bloqueo + contacto) */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
        {bloqueado ? (
          <AccionBtn onClick={() => setModalAbierto('desbloquear')}>Desbloquear socio</AccionBtn>
        ) : (
          <AccionBtn onClick={() => setModalAbierto('bloquear')}>Bloquear socio</AccionBtn>
        )}
        <AccionBtn onClick={() => setModalAbierto('editar_contacto')}>Editar contacto</AccionBtn>
        <AccionBtn onClick={() => setModalAbierto('enviar_aviso')}>Enviar aviso</AccionBtn>
        {socio.auth_id ? (
          <AccionBtn onClick={() => setModalAbierto('reset_password')}>Resetear contraseña</AccionBtn>
        ) : (
          <AccionBtn onClick={() => setModalAbierto('crear_acceso')}>Dar acceso a la app</AccionBtn>
        )}
        {/* El label dice el estado: así recepción no abre el modal para averiguarlo. */}
        <AccionBtn onClick={() => setModalAbierto('huella')}>
          {huellas.length > 0 ? `Huella (${huellas.length})` : 'Registrar huella'}
        </AccionBtn>
      </div>

      {multas.length > 0 && (
        <div
          className="ek-card ek-card--md"
          style={{ marginBottom: '12px', border: '1px solid var(--sala-primary)' }}
        >
          <span className="ek-eyebrow">MULTAS PENDIENTES</span>
          <div style={{ display: 'grid', gap: '10px', marginTop: '10px' }}>
            {multas.map((m) => (
              <MultaRow
                key={m.id}
                multa={m}
                onCobrada={async () => {
                  await refetchMultas();
                  setPagosReload((n) => n + 1);
                }}
              />
            ))}
          </div>
        </div>
      )}

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

        {membresia && estado !== 'sin_plan' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px', flexWrap: 'wrap' }}>
            <span className="ek-label" style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)' }}>Suele pagar con</span>
            <MetodoPagoMembresia usuarioId={socio.id} valor={membresia.metodoPago} />
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' }}>
          {estado === 'activa' && (
            <>
              <AccionBtn onClick={() => setModalAbierto('renovar')}>Renovar</AccionBtn>
              <AccionBtn onClick={() => setModalAbierto('cambiar_plan')}>Cambiar plan</AccionBtn>
              {esCreditos && <AccionBtn onClick={() => setModalAbierto('recargar')}>Recargar créditos</AccionBtn>}
              <AccionBtn onClick={() => setModalAbierto('pausar')}>Pausar</AccionBtn>
              <AccionBtn onClick={() => setModalAbierto('cancelar_membresia')}>Cancelar membresía</AccionBtn>
            </>
          )}
          {estado === 'pausada' && (
            <>
              <AccionBtn onClick={() => setModalAbierto('reactivar')}>Reactivar</AccionBtn>
              <AccionBtn onClick={() => setModalAbierto('cambiar_plan')}>Cambiar plan</AccionBtn>
              <AccionBtn onClick={() => setModalAbierto('cancelar_membresia')}>Cancelar membresía</AccionBtn>
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '9px' }}>
          <p className="ek-eyebrow" style={{ margin: 0 }}>PRÓXIMAS RESERVAS</p>
          {/* Walk-in: el socio llegó sin reservar. Solo con membresía viva —
              sin plan no puede entrar a una clase, igual que desde la app. */}
          {(estado === 'activa') && (
            <AccionBtn onClick={() => setModalAbierto('crear_reserva')}>+ Crear reserva</AccionBtn>
          )}
        </div>
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
            const f = fmtReserva(r.slot_inicio, tz, hoyISO);
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
                  {r.invitados.length > 0 && (
                    <div style={{ fontSize: '11px', color: 'var(--sala-text-secondary)', marginTop: '2px' }}>
                      + {r.invitados.length} invitado{r.invitados.length === 1 ? '' : 's'}: {r.invitados.join(', ')}
                    </div>
                  )}
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

      {/* HISTORIAL DE RESERVAS */}
      <div className="ek-card ek-card--md" style={{ marginBottom: '12px' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '9px' }}>HISTORIAL DE RESERVAS</p>
        {historial.length === 0 ? (
          <p style={{ textAlign: 'center', color: 'var(--sala-text-tertiary)', fontSize: '13px', padding: '6px 0', margin: 0 }}>
            Sin reservas pasadas todavía.
          </p>
        ) : (
          historial.map((r, i) => {
            const f = fmtReserva(r.slot_inicio, tz, hoyISO);
            const cfg = HIST_STATUS[r.status];
            const corregible = r.status === 'no_show' || r.status === 'cancelada' || r.status === 'cancelada_admin';
            return (
              <div
                key={r.id}
                style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderTop: i === 0 ? 'none' : '1px solid var(--sala-border-subtle, var(--sala-border))' }}
              >
                <div style={{ fontFamily: 'var(--ek-font-display)', fontWeight: 700, fontSize: '13px', minWidth: '70px' }}>
                  {f.dia} {f.hora}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '13px' }}>{r.recursoNombre ?? 'Clase'}</div>
                  {r.invitados.length > 0 && (
                    <div style={{ fontSize: '11px', color: 'var(--sala-text-secondary)', marginTop: '2px' }}>
                      + {r.invitados.length} invitado{r.invitados.length === 1 ? '' : 's'}: {r.invitados.join(', ')}
                    </div>
                  )}
                </div>
                {corregible && (
                  <button
                    type="button"
                    onClick={() => void marcarAsistio(r.id)}
                    disabled={corrigiendo === r.id}
                    className="ek-cta ek-cta--secondary"
                    style={{ fontSize: '11px', padding: '4px 10px' }}
                  >
                    {corrigiendo === r.id ? '…' : 'Sí asistió'}
                  </button>
                )}
                <span
                  style={{
                    fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                    color: cfg.color, background: cfg.bg, padding: '3px 8px', borderRadius: '999px', whiteSpace: 'nowrap',
                  }}
                >
                  {cfg.label}
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
        {invitadosBolsa.incluidos > 0 && (
          <p style={{ margin: '10px 0 0', fontSize: '12px', color: 'var(--sala-text-secondary)' }}>
            Invitados: le quedan{' '}
            <strong style={{ color: 'var(--sala-text-primary)' }}>{invitadosBolsa.disponibles}</strong>{' '}
            de {invitadosBolsa.incluidos} este periodo.
          </p>
        )}
      </div>

      {/* PAGOS Y RECIBOS */}
      <div className="ek-card ek-card--md" style={{ marginBottom: '12px' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '9px' }}>PAGOS</p>
        <HistorialPagosSocio usuarioId={socio.id} reloadKey={pagosReload} />
      </div>

      {/* NOTAS SOBRE EL SOCIO (con autor + fecha) */}
      <div className="ek-card ek-card--md">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '9px' }}>
          <p className="ek-eyebrow" style={{ margin: 0 }}>NOTAS SOBRE EL SOCIO</p>
          <AccionBtn onClick={() => setModalAbierto('agregar_nota')}>+ Agregar nota</AccionBtn>
        </div>

        {/* Nota general legacy (usuarios.notas_admin), si hay */}
        {socio.notas_admin && socio.notas_admin.trim() && (
          <div style={{ borderLeft: '2px solid var(--sala-border)', paddingLeft: '10px', marginBottom: '10px' }}>
            <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--sala-text-tertiary)', margin: '0 0 3px' }}>Nota general</p>
            <p style={{ fontSize: '13.5px', lineHeight: 1.5, color: 'var(--sala-text-primary)', margin: 0, whiteSpace: 'pre-wrap' }}>{socio.notas_admin}</p>
          </div>
        )}

        {notas.length === 0 && !(socio.notas_admin && socio.notas_admin.trim()) ? (
          <p style={{ textAlign: 'center', color: 'var(--sala-text-tertiary)', fontSize: '13px', padding: '6px 0', margin: 0 }}>
            Sin notas todavía.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {notas.map((n) => (
              <div key={n.id} style={{ borderTop: '1px solid var(--sala-border)', paddingTop: '8px' }}>
                <p style={{ fontSize: '13.5px', lineHeight: 1.5, color: 'var(--sala-text-primary)', margin: '0 0 3px', whiteSpace: 'pre-wrap' }}>{n.texto}</p>
                <p style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)', margin: 0 }}>
                  {n.autor_nombre ?? 'Recepción'} · {new Date(n.creado_en).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {modalAbierto === 'crear_reserva' && (
        <CrearReservaModal
          socioId={socio.id}
          socioNombre={socio.nombre ?? 'el socio'}
          isOpen
          onClose={cerrar}
          onDone={handleDone}
        />
      )}

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
      {modalAbierto === 'cancelar_membresia' && (
        <CancelarMembresiaModal
          isOpen
          socioId={socio.id}
          socioNombre={socioNombre}
          onClose={cerrar}
          onDone={handleDone}
        />
      )}
      {modalAbierto === 'bloquear' && (
        <BloquearSocioModal
          isOpen
          socioId={socio.id}
          socioNombre={socioNombre}
          onClose={cerrar}
          onDone={handleDone}
        />
      )}
      {modalAbierto === 'desbloquear' && (
        <DesbloquearSocioModal
          isOpen
          socioId={socio.id}
          socioNombre={socioNombre}
          onClose={cerrar}
          onDone={handleDone}
        />
      )}
      {modalAbierto === 'agregar_nota' && (
        <AgregarNotaModal
          isOpen
          socioId={socio.id}
          socioNombre={socioNombre}
          onClose={cerrar}
          onDone={handleDone}
        />
      )}
      {modalAbierto === 'editar_contacto' && (
        <EditarContactoModal
          isOpen
          socioId={socio.id}
          socioNombre={socioNombre}
          telefonoActual={socio.telefono}
          emailActual={socio.email}
          onClose={cerrar}
          onDone={handleDone}
        />
      )}
      {modalAbierto === 'enviar_aviso' && (
        <EnviarAvisoModal
          isOpen
          socioId={socio.id}
          socioNombre={socioNombre}
          onClose={cerrar}
          onDone={handleDone}
        />
      )}
      {modalAbierto === 'reset_password' && (
        <ResetPasswordModal
          isOpen
          socioId={socio.id}
          socioNombre={socioNombre}
          onClose={cerrar}
          onDone={handleDone}
        />
      )}
      {modalAbierto === 'crear_acceso' && (
        <CrearAccesoSocioModal
          isOpen
          socioId={socio.id}
          socioNombre={socioNombre}
          emailActual={socio.email}
          onClose={cerrar}
          onDone={handleDone}
        />
      )}
      {modalAbierto === 'huella' && (
        <HuellaModal
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
        <b>Plan vencido el {fmtFechaCorta(membresia?.periodoFin ?? null)}</b> — renueva para reactivar el acceso.
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
        <b>Sin membresía activa</b> — asígnale un plan para que pueda reservar.
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
