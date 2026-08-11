import { useParams, Link, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check } from 'lucide-react';
import {
  useMiembroDetalle,
  adminUpdateRole,
  adminDeleteUser
} from '../hooks/useAdminData';
import { useMiembroKPIs } from '../hooks/useMiembroKPIs';
import { useSucursal } from '../providers/SucursalProvider';
import { supabase } from '@shared/lib/supabase';
import { backendPost } from '@shared/lib/backend';
import { PASSWORD_TEMPORAL_INICIAL } from '@shared/lib/acceso';
import { esCorreoMarcador, etiquetaCorreo } from '@shared/lib/sinCorreo';
import { calcularEdad } from '@shared/lib/edad';
import { useToast } from '@shared/hooks/useToast';
import ConfirmDialog from '../components/ConfirmDialog';
import { MiembroHero } from '../components/miembro/MiembroHero';
import { MiembroKPIs } from '../components/miembro/MiembroKPIs';
import {
  MiembroProximasReservas,
  type ReservaListItem
} from '../components/miembro/MiembroProximasReservas';
import {
  MiembroHistorial,
  type HistorialItem
} from '../components/miembro/MiembroHistorial';
import { HistorialPagosSocio } from '@shared/components/HistorialPagosSocio';
import { MetodoPagoMembresia } from '@shared/components/MetodoPagoMembresia';
import { MiembroHistorialCambios } from '../components/miembro/MiembroHistorialCambios';
import { MiembroNotasInternas } from '../components/miembro/MiembroNotasInternas';
import { GestionarMembresiaModal } from '../components/miembro/GestionarMembresiaModal';
import { BloquearAccesoModal } from '../components/miembro/BloquearAccesoModal';
import { EnviarAvisoModal } from '../components/miembro/EnviarAvisoModal';
import type { Database } from '@shared/types/database';

type Recurso = Pick<Database['public']['Tables']['recursos']['Row'], 'nombre'>;

export default function MiembroDetalle() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { miembro, reservas, isLoading, refetch } = useMiembroDetalle(id);
  const { kpis, isLoading: loadingKpis, refetch: refetchKpis } = useMiembroKPIs(id);

  // Membresía del socio: la ÚLTIMA (cualquier estado), leída de `membresias` —
  // la fuente de verdad, igual que recepción. `usuarios.membresia_tier` se NULLea
  // al vencer (para acceso/reportes), así que leerlo dejaba "sin plan" a un socio
  // con plan vencido mientras recepción sí lo mostraba. Leyendo de `membresias`,
  // admin y recepción coinciden.
  const [membresia, setMembresia] = useState<{ nombre: string | null; estado: string; periodoFin: Date | null; creditos: number | null; metodoPago: string | null } | null>(null);
  const [pagosReload, setPagosReload] = useState(0);
  const [invitados, setInvitados] = useState<{ incluidos: number; usados: number; disponibles: number } | null>(null);
  useEffect(() => {
    if (!id) return;
    let mounted = true;
    void (async () => {
      const res = await supabase
        .from('membresias')
        .select('status, periodo_actual_fin, creditos_restantes, metodo_pago, tier:tiers(nombre, tipo)')
        .eq('usuario_id', id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      // Cast laxo: los tipos generados aún no incluyen `metodo_pago` (columna nueva).
      const data = res.data as unknown as {
        status: string; periodo_actual_fin: string | null; creditos_restantes: number | null;
        metodo_pago: string | null; tier: { nombre?: string; tipo?: string } | null;
      } | null;
      if (!mounted) return;
      if (!data) { setMembresia(null); return; }
      let estado = String(data.status ?? '');
      const fin = (data.periodo_actual_fin as string | undefined) ?? null;
      // Defensa por fecha: si el periodo ya terminó, se muestra vencida AUNQUE
      // la base aún diga 'activa' (el cron de expiración puede ir atrasado).
      const statusActivo = estado === 'activa' || estado === 'trialing' || estado === 'past_due';
      if (statusActivo && fin && new Date(fin).getTime() < Date.now()) estado = 'expirada';
      const activa = statusActivo && estado !== 'expirada';
      const tier = data.tier as { nombre?: string; tipo?: string } | null;
      setMembresia({
        nombre: tier?.nombre ?? null,
        estado,
        periodoFin: activa && fin ? new Date(fin) : null,
        // Créditos solo de un plan VIGENTE: "1 clase restante" de un day pass
        // vencido es mentira útil para nadie.
        creditos: activa && (tier?.tipo === 'creditos' || tier?.tipo === 'hibrido') ? ((data.creditos_restantes as number | null) ?? null) : null,
        metodoPago: (data.metodo_pago as string | null) ?? null
      });
    })();
    return () => { mounted = false; };
  }, [id, miembro]);

  // Bolsa de invitados del socio (si su plan los incluye). Misma RPC que socio y
  // recepción; el admin pasa is_recepcionista(), así que puede consultarla.
  useEffect(() => {
    if (!id) return;
    let mounted = true;
    void (async () => {
      const { data } = await supabase.rpc('invitados_disponibles', { p_usuario_id: id });
      if (!mounted) return;
      const d = (data ?? null) as { incluidos?: number; usados?: number; disponibles?: number } | null;
      setInvitados(d ? { incluidos: d.incluidos ?? 0, usados: d.usados ?? 0, disponibles: d.disponibles ?? 0 } : null);
    })();
    return () => { mounted = false; };
  }, [id, miembro]);

  const [showCambiarPlan, setShowCambiarPlan] = useState(false);
  const [showBloquear, setShowBloquear] = useState(false);
  const [showAviso, setShowAviso] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Particionar reservas: futuras (próximas 5 confirmadas) + historial (últimos 30 días)
  const ahora = Date.now();
  const hace30Dias = ahora - 30 * 24 * 60 * 60 * 1000;
  type ReservaJoined = (typeof reservas)[number];

  const proximasReservas = useMemo<ReservaListItem[]>(
    () =>
      (reservas as ReservaJoined[])
        .filter(
          (r) =>
            r.status === 'confirmada' &&
            new Date(r.slot_inicio).getTime() >= ahora
        )
        .sort(
          (a, b) =>
            new Date(a.slot_inicio).getTime() - new Date(b.slot_inicio).getTime()
        )
        .slice(0, 5)
        .map((r) => ({
          id: r.id,
          slot_inicio: r.slot_inicio,
          recurso_nombre: (r.recurso as Recurso | null)?.nombre ?? '—',
          status: r.status
        })),
    [reservas, ahora]
  );

  const historialItems = useMemo<HistorialItem[]>(
    () =>
      (reservas as ReservaJoined[])
        .filter((r) => {
          const ms = new Date(r.slot_inicio).getTime();
          const isHistoricStatus =
            r.status === 'completada' ||
            r.status === 'no_show' ||
            r.status === 'cancelada' ||
            r.status === 'cancelada_admin';
          return isHistoricStatus && ms >= hace30Dias && ms < ahora;
        })
        .sort(
          (a, b) =>
            new Date(b.slot_inicio).getTime() - new Date(a.slot_inicio).getTime()
        )
        .slice(0, 30)
        .map((r) => ({
          id: r.id,
          slot_inicio: r.slot_inicio,
          recurso_nombre: (r.recurso as Recurso | null)?.nombre ?? '—',
          status: r.status as HistorialItem['status']
        })),
    [reservas, ahora, hace30Dias]
  );

  if (isLoading) return <p className="adm-body">Cargando…</p>;
  if (!miembro) return <p className="adm-body">Miembro no encontrado.</p>;

  // El plan viene de la membresía (fuente real). Si no está activa, se muestra su
  // estado (vencido/pausado) — así admin no dice "sin plan" cuando en realidad el
  // socio tuvo uno que venció (como lo muestra recepción).
  const membresiaActiva = !!membresia && ['activa', 'trialing', 'past_due'].includes(membresia.estado);
  const planNombre = membresia?.nombre
    ? membresiaActiva
      ? membresia.nombre
      : `${membresia.nombre} (${membresia.estado === 'congelada' ? 'pausado' : 'vencido'})`
    : null;
  const periodoFin = membresia?.periodoFin ?? null;
  const creditosRestantes = membresia?.creditos ?? null;

  const diasParaVencimiento = periodoFin
    ? Math.ceil((periodoFin.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : null;

  const bloqueadoHasta =
    miembro.bloqueado_hasta && new Date(miembro.bloqueado_hasta) > new Date()
      ? new Date(miembro.bloqueado_hasta)
      : null;

  async function handleAfterChange() {
    await Promise.all([refetch(), refetchKpis()]);
    // Refresca el historial de pagos: el cobro recién hecho aparece arriba con Recibo.
    setPagosReload((n) => n + 1);
  }

  async function handleDelete() {
    if (!miembro) return;
    setDeleting(true);
    const { data, error: err } = await adminDeleteUser({ usuarioId: miembro.id });
    setDeleting(false);
    if (err) {
      toast.error(err.error);
      setShowDelete(false);
      return;
    }
    toast.success(`${data.email} eliminado. El email queda liberado para re-uso.`);
    navigate('/admin/miembros');
  }

  return (
    <div className="adm-page">
      <Link to="/admin/miembros" className="adm-link" style={{ marginBottom: '12px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
        <ArrowLeft size={15} strokeWidth={2.25} />
        Volver a Miembros
      </Link>

      <MiembroHero
        miembro={miembro}
        planNombre={planNombre}
        diasParaVencimiento={diasParaVencimiento}
        creditosRestantes={creditosRestantes}
        estaBloqueado={!!bloqueadoHasta}
        onCambiarPlan={() => setShowCambiarPlan(true)}
        onBloquearAcceso={() => setShowBloquear(true)}
      />

      <MiembroKPIs kpis={kpis} isLoading={loadingKpis} />

      {membresia && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', margin: '4px 0 24px' }}>
          <span className="ek-label" style={{ fontSize: '12px', color: 'var(--sala-text-secondary)' }}>Método de pago</span>
          <MetodoPagoMembresia usuarioId={miembro.id} valor={membresia.metodoPago} />
        </div>
      )}

      {invitados && invitados.incluidos > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', margin: '4px 0 24px' }}>
          <span className="ek-label" style={{ fontSize: '12px', color: 'var(--sala-text-secondary)' }}>Invitados este periodo</span>
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--sala-text-primary)' }}>
            {invitados.disponibles} de {invitados.incluidos} disponibles
            <span style={{ color: 'var(--sala-text-tertiary)', fontWeight: 500 }}>
              {' · '}{invitados.usados} usado{invitados.usados === 1 ? '' : 's'}
            </span>
          </span>
        </div>
      )}

      <section style={{ marginBottom: '32px' }}>
        <SectionHeading>Próximas reservas</SectionHeading>
        <MiembroProximasReservas
          reservas={proximasReservas}
          usuarioNombre={miembro.nombre ?? miembro.email}
          onAfterCancel={handleAfterChange}
        />
      </section>

      <section style={{ marginBottom: '32px' }}>
        <SectionHeading hint="Últimos 30 días">Historial de asistencia</SectionHeading>
        <MiembroHistorial items={historialItems} />
      </section>

      <section style={{ marginBottom: '32px' }}>
        <SectionHeading hint="Recibo por cobro">Pagos y recibos</SectionHeading>
        <HistorialPagosSocio usuarioId={miembro.id} reloadKey={pagosReload} />
      </section>

      <section style={{ marginBottom: '32px' }}>
        <SectionHeading hint="Quién hizo qué">Historial de cambios</SectionHeading>
        <MiembroHistorialCambios usuarioId={miembro.id} />
      </section>

      <section style={{ marginBottom: '32px' }}>
        <SectionHeading>Comunicación</SectionHeading>
        <button type="button" className="ek-cta ek-cta--secondary" onClick={() => setShowAviso(true)}>
          Enviar aviso
        </button>
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', marginTop: '8px' }}>
          Le llega al socio en su campana de notificaciones. Queda en el historial de cambios.
        </p>
      </section>

      <section style={{ marginBottom: '32px' }}>
        <SectionHeading>Notas internas</SectionHeading>
        <MiembroNotasInternas
          usuarioId={miembro.id}
          notasIniciales={(miembro as { notas_admin?: string | null }).notas_admin ?? null}
          onSaved={refetch}
        />
      </section>

      {/* Editar datos del miembro — colapsible */}
      <details
        style={{
          background: 'var(--sala-surface)',
          border: '1px solid var(--sala-border)',
          borderRadius: '14px',
          padding: '0',
          marginBottom: '24px',
          overflow: 'hidden'
        }}
      >
        <summary
          style={{
            cursor: 'pointer',
            padding: '14px 18px',
            fontFamily: 'var(--ek-font-display)',
            fontSize: '15px',
            fontWeight: 600,
            color: 'var(--sala-text-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            listStyle: 'none'
          }}
        >
          <span>Editar datos del miembro</span>
          <span style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', fontWeight: 500 }}>
            (datos personales, foto, rol, contraseña)
          </span>
        </summary>
        <div style={{ padding: '20px', borderTop: '1px solid var(--sala-border)', display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <FieldGroup title="Datos personales">
            <EditarDatosForm miembro={miembro} onSaved={refetch} />
          </FieldGroup>

          {/* Socio sin login todavía: se activa SOLO en la landing (sin código). */}
          {!miembro.auth_id && (
            <FieldGroup title="Activación de cuenta">
              <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, lineHeight: 1.5 }}>
                Este socio aún no tiene acceso a la app. Se activa <strong>él mismo</strong> en{' '}
                <strong>{`${window.location.origin}/activar`}</strong> con su correo (<strong>{miembro.email}</strong>):
                ahí el sistema le da su contraseña temporal. No hace falta ningún código.
              </p>
            </FieldGroup>
          )}

          <FieldGroup title="Estado de la cuenta">
            <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '0 0 8px' }}>
              El miembro debe estar <strong>Activo</strong> para poder reservar clases.
            </p>
            <CambiarEstadoControl
              usuarioId={miembro.id}
              statusActual={miembro.status}
              onChanged={refetch}
            />
          </FieldGroup>

          <FieldGroup title="Foto">
            <AvatarUploadControl
              usuarioId={miembro.id}
              avatarUrl={miembro.avatar_url}
              onChanged={refetch}
            />
          </FieldGroup>

          <FieldGroup title="Rol">
            <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '0 0 8px' }}>
              Rol actual: <RolBadge rol={miembro.rol} />
            </p>
            <CambiarRolControl
              usuarioId={miembro.id}
              rolActual={miembro.rol}
              onChanged={refetch}
            />
          </FieldGroup>

          {miembro.auth_id && (
            <FieldGroup title="Cuenta">
              <ResetPasswordControl usuarioId={miembro.id} />
            </FieldGroup>
          )}

          <FieldGroup title="Información del sistema">
            <div className="adm-info-grid">
              <Info label="Email" value={etiquetaCorreo(miembro.email)} />
              <Info label="Rol" value={miembro.rol} mono />
              <Info label="Alta" value={new Date(miembro.created_at).toLocaleString('es-MX')} />
              {miembro.commitment_ends_at && (
                <Info
                  label="Commitment hasta"
                  value={new Date(miembro.commitment_ends_at).toLocaleDateString('es-MX')}
                />
              )}
              {bloqueadoHasta && (
                <Info label="Bloqueado hasta" value={bloqueadoHasta.toLocaleString('es-MX')} />
              )}
            </div>
          </FieldGroup>
        </div>
      </details>

      {/* Zona peligrosa (FIX02) */}
      <section
        style={{
          marginTop: '24px',
          padding: '20px 24px',
          background: 'var(--sala-error-bg)',
          border: '1px solid var(--sala-error-glow)',
          borderRadius: '14px'
        }}
      >
        <p
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--sala-error)',
            margin: 0,
            marginBottom: '8px'
          }}
        >
          Zona peligrosa
        </p>
        <p style={{ fontSize: '14px', color: 'var(--sala-text-primary)', margin: 0, marginBottom: '6px', lineHeight: 1.5 }}>
          Eliminar al miembro libera el email <strong>{miembro.email}</strong> para re-uso inmediato. La acción es permanente.
        </p>
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, marginBottom: '16px', lineHeight: 1.5 }}>
          Si el miembro tiene reservas en historial, vas a tener que cancelarlas primero o usar <strong>Suspender</strong> (status="cancelado") desde "Editar datos" en su lugar.
        </p>
        <button
          type="button"
          onClick={() => setShowDelete(true)}
          style={{
            background: 'var(--sala-error)',
            color: 'var(--sala-text-on-accent)',
            border: '1px solid var(--sala-error)',
            borderRadius: '10px',
            padding: '10px 18px',
            minHeight: '40px',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit'
          }}
        >
          Eliminar definitivamente
        </button>
      </section>

      {/* Modales */}
      {showCambiarPlan && (
        <GestionarMembresiaModal
          usuarioId={miembro.id}
          nombreMiembro={miembro.nombre ?? miembro.email}
          onClose={() => setShowCambiarPlan(false)}
          onSaved={handleAfterChange}
        />
      )}

      {showAviso && (
        <EnviarAvisoModal
          isOpen
          socioId={miembro.id}
          socioNombre={miembro.nombre ?? miembro.email}
          onClose={() => setShowAviso(false)}
          onDone={async () => { setShowAviso(false); await refetch(); }}
        />
      )}
      {showBloquear && (
        <BloquearAccesoModal
          usuarioId={miembro.id}
          nombreMiembro={miembro.nombre ?? miembro.email}
          bloqueadoHasta={bloqueadoHasta}
          onClose={() => setShowBloquear(false)}
          onSaved={handleAfterChange}
        />
      )}

      <ConfirmDialog
        isOpen={showDelete}
        title={`¿Eliminar a ${miembro.nombre ?? miembro.email}?`}
        description={`Esta acción es permanente. El email "${miembro.email}" queda liberado para re-uso. Escribe ELIMINAR para confirmar.`}
        confirmLabel={deleting ? 'Eliminando…' : 'Eliminar definitivamente'}
        variant="danger"
        requireTypedConfirmation="ELIMINAR"
        onConfirm={handleDelete}
        onCancel={() => !deleting && setShowDelete(false)}
      />
    </div>
  );
}

// ============================================================================
// Helpers locales preservados (todos los edit-forms existentes)
// ============================================================================

function SectionHeading({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: '14px',
        gap: '12px',
        flexWrap: 'wrap'
      }}
    >
      <h2
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '18px',
          fontWeight: 600,
          letterSpacing: '-0.02em',
          color: 'var(--sala-text-primary)',
          margin: 0
        }}
      >
        {children}
      </h2>
      {hint && (
        <span
          style={{
            fontSize: '11px',
            color: 'var(--sala-text-tertiary)',
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase'
          }}
        >
          {hint}
        </span>
      )}
    </div>
  );
}

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p
        style={{
          fontSize: '11px',
          fontWeight: 700,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--sala-primary)',
          margin: 0,
          marginBottom: '10px'
        }}
      >
        {title}
      </p>
      {children}
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="adm-info-label">{label}</p>
      <p className="adm-info-value" style={mono ? { fontFamily: 'var(--ek-font-mono)' } : undefined}>
        {value}
      </p>
    </div>
  );
}

function RolBadge({ rol }: { rol: string }) {
  return (
    <code
      style={{
        fontFamily: 'var(--ek-font-mono)',
        background: 'var(--sala-bg)',
        color: 'var(--sala-text-primary)',
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '12px',
        border: '1px solid var(--sala-border)'
      }}
    >
      {rol}
    </code>
  );
}

const ESTADO_OPCIONES: { value: string; label: string }[] = [
  { value: 'pendiente_onboarding', label: 'Pendiente onboarding' },
  { value: 'pendiente_pago', label: 'Pendiente pago' },
  { value: 'activo', label: 'Activo' },
  { value: 'suspendido', label: 'Suspendido' },
  { value: 'cancelado', label: 'Cancelado' }
];

function CambiarEstadoControl({
  usuarioId,
  statusActual,
  onChanged
}: {
  usuarioId: string;
  statusActual: string;
  onChanged: () => Promise<void>;
}) {
  const [nuevoStatus, setNuevoStatus] = useState(statusActual);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (nuevoStatus === statusActual) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const { error } = await supabase
        .from('usuarios')
        .update({ status: nuevoStatus })
        .eq('id', usuarioId);
      if (error) throw error;
      await onChanged();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos cambiar el estado. Prueba de nuevo.');
    }
    setSaving(false);
  }

  return (
    <div className="adm-form-row" style={{ marginTop: '0.5rem' }}>
      <label className="ek-label" style={{ flex: 1 }}>
        Estado
        <select
          value={nuevoStatus}
          onChange={(e) => setNuevoStatus(e.target.value)}
          className="ek-input"
        >
          {ESTADO_OPCIONES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button
        onClick={handleSave}
        disabled={saving || nuevoStatus === statusActual}
        className="ek-cta"
        style={{ alignSelf: 'flex-end' }}
      >
        {saving ? '…' : 'Cambiar estado'}
      </button>
      {saved && (
        <span style={{ color: 'var(--sala-success)', fontSize: '0.8125rem', flexBasis: '100%', marginTop: '0.5rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <Check size={14} strokeWidth={2.5} />
          Estado actualizado
        </span>
      )}
      {error && <p className="ek-error-text">{error}</p>}
    </div>
  );
}

function CambiarRolControl({
  usuarioId,
  rolActual,
  onChanged
}: {
  usuarioId: string;
  rolActual: string;
  onChanged: () => Promise<void>;
}) {
  const [nuevoRol, setNuevoRol] = useState<'miembro' | 'recepcionista' | 'staff' | 'admin'>(
    rolActual as 'miembro' | 'recepcionista' | 'staff' | 'admin'
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);

  async function handleSave() {
    if (nuevoRol === rolActual) return;
    if (nuevoRol === 'admin' && !needsConfirm) {
      setNeedsConfirm(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await adminUpdateRole({ usuario_id: usuarioId, rol: nuevoRol });
      await onChanged();
      setNeedsConfirm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos cambiar el rol. Prueba de nuevo.');
    }
    setSaving(false);
  }

  return (
    <div className="adm-form-row" style={{ marginTop: '0.5rem' }}>
      <label className="ek-label" style={{ flex: 1 }}>
        Nuevo rol
        <select
          value={nuevoRol}
          onChange={(e) => setNuevoRol(e.target.value as typeof nuevoRol)}
          className="ek-input"
        >
          <option value="miembro">Miembro</option>
          <option value="recepcionista">Recepción</option>
          {/* 'staff' desactivado como destino. Solo se ofrece si la persona YA es
              staff legacy (para poder reasignarla); no se puede asignar de nuevo. */}
          {rolActual === 'staff' && <option value="staff">Staff (legacy)</option>}
          <option value="admin">Admin</option>
        </select>
      </label>
      <button
        onClick={handleSave}
        disabled={saving || nuevoRol === rolActual}
        className="ek-cta"
        style={{ alignSelf: 'flex-end' }}
      >
        {saving ? '…' : needsConfirm && nuevoRol === 'admin' ? 'Confirmar admin' : 'Cambiar rol'}
      </button>
      {error && <p className="ek-error-text">{error}</p>}
      {needsConfirm && nuevoRol === 'admin' && (
        <p style={{ fontSize: '0.8125rem', color: 'var(--sala-error)', flexBasis: '100%', marginTop: '0.5rem', display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
          <AlertTriangle size={14} strokeWidth={2.25} style={{ flexShrink: 0, marginTop: '2px' }} />
          <span>Promover a admin da acceso TOTAL al negocio. Click "Confirmar admin" para proceder.</span>
        </p>
      )}
    </div>
  );
}

function AvatarUploadControl({
  usuarioId,
  avatarUrl,
  onChanged
}: {
  usuarioId: string;
  avatarUrl: string | null;
  onChanged: () => Promise<void>;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `${usuarioId}/${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage
        .from('avatars')
        .upload(path, file, { cacheControl: '3600', upsert: false });
      if (uploadErr) throw uploadErr;
      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);
      const { error: updateErr } = await supabase
        .from('usuarios')
        .update({ avatar_url: publicUrl })
        .eq('id', usuarioId);
      if (updateErr) throw updateErr;
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos subir la foto. Prueba con otra imagen.');
    }
    setUploading(false);
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt="Avatar"
          style={{
            width: '80px',
            height: '80px',
            borderRadius: '50%',
            objectFit: 'cover',
            border: '1px solid var(--sala-border-strong)'
          }}
        />
      ) : (
        <div
          style={{
            width: '80px',
            height: '80px',
            borderRadius: '50%',
            background: 'var(--sala-bg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--sala-text-tertiary)',
            fontSize: '0.875rem',
            border: '1px dashed var(--sala-border-strong)'
          }}
        >
          Sin foto
        </div>
      )}
      <label className="ek-cta ek-cta--secondary" style={{ cursor: 'pointer' }}>
        {uploading ? 'Subiendo…' : avatarUrl ? 'Cambiar foto' : 'Subir foto'}
        <input
          type="file"
          accept="image/*"
          disabled={uploading}
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          style={{ display: 'none' }}
        />
      </label>
      {error && <p className="ek-error-text">{error}</p>}
    </div>
  );
}

function EditarDatosForm({
  miembro,
  onSaved
}: {
  miembro: Database['public']['Tables']['usuarios']['Row'];
  onSaved: () => Promise<void>;
}) {
  const { sucursales, multisede } = useSucursal();
  const [nombre, setNombre] = useState(miembro.nombre ?? '');
  const [telefono, setTelefono] = useState(miembro.telefono ?? '');
  const [sucursalId, setSucursalId] = useState(miembro.sucursal_id ?? '');
  // Socio importado sin correo: recepción le pone su email real acá para que
  // pueda activar su cuenta. Solo para estos (los que ya tienen login no se
  // editan acá, para no desincronizar su email de auth).
  const socioSinCorreo = esCorreoMarcador(miembro.email);
  const [email, setEmail] = useState(socioSinCorreo ? '' : (miembro.email ?? ''));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ficha de datos (tabla privada usuarios_datos_privados): nacimiento, sexo,
  // domicilio. Se cargan aparte y se guardan con upsert.
  const [fechaNac, setFechaNac] = useState('');
  const [sexo, setSexo] = useState('');
  const [domicilio, setDomicilio] = useState('');
  const [fichaOrig, setFichaOrig] = useState({ fechaNac: '', sexo: '', domicilio: '' });
  useEffect(() => {
    let cancel = false;
    void (async () => {
      const { data } = await (supabase as any)
        .from('usuarios_datos_privados')
        .select('fecha_nacimiento, sexo, domicilio')
        .eq('usuario_id', miembro.id)
        .maybeSingle();
      if (cancel) return;
      const fn = (data?.fecha_nacimiento ?? '') as string;
      const sx = (data?.sexo ?? '') as string;
      const dm = (data?.domicilio ?? '') as string;
      setFechaNac(fn); setSexo(sx); setDomicilio(dm);
      setFichaOrig({ fechaNac: fn, sexo: sx, domicilio: dm });
    })();
    return () => { cancel = true; };
  }, [miembro.id]);

  const emailNuevo = email.trim();
  const emailCambio =
    emailNuevo.length > 0 && emailNuevo.toLowerCase() !== (miembro.email ?? '').toLowerCase();
  const fichaDirty = fechaNac !== fichaOrig.fechaNac || sexo !== fichaOrig.sexo || domicilio !== fichaOrig.domicilio;
  const isDirty =
    nombre !== (miembro.nombre ?? '') ||
    telefono !== (miembro.telefono ?? '') ||
    sucursalId !== (miembro.sucursal_id ?? '') ||
    emailCambio ||
    fichaDirty;

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const patch: Record<string, unknown> = {
        nombre: nombre.trim() || null,
        telefono: telefono.trim() || null,
        sucursal_id: sucursalId || null
      };
      const { error } = await supabase
        .from('usuarios')
        .update(patch as never)
        .eq('id', miembro.id);
      if (error) throw error;

      // El EMAIL va por la función: cambia el de acceso (auth) Y el de la ficha a
      // la vez, para no desincronizar el login. Sirve para cualquier socio.
      if (emailCambio) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNuevo)) {
          throw new Error('El correo no es válido.');
        }
        await backendPost('staff-editar-email', { usuario_id: miembro.id, email: emailNuevo.toLowerCase() });
      }

      // Ficha de datos (tabla privada): upsert si cambió algo.
      if (fichaDirty) {
        const { error: e2 } = await (supabase as any)
          .from('usuarios_datos_privados')
          .upsert(
            {
              usuario_id: miembro.id,
              tenant_id: miembro.tenant_id,
              fecha_nacimiento: fechaNac || null,
              sexo: sexo || null,
              domicilio: domicilio.trim() || null
            },
            { onConflict: 'usuario_id' }
          );
        if (e2) throw e2;
        setFichaOrig({ fechaNac, sexo, domicilio });
      }
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos guardar los cambios. Prueba de nuevo.');
    }
    setSaving(false);
  }

  return (
    <div className="adm-info-grid" style={{ background: 'transparent', padding: 0, border: 'none' }}>
      <label className="ek-label">
        Nombre
        <input
          type="text"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          className="ek-input"
          placeholder="Nombre completo"
        />
      </label>
      <label className="ek-label">
        Correo{socioSinCorreo ? ' (para activar su cuenta)' : ''}
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="ek-input"
          placeholder="correo@ejemplo.com"
        />
        <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>
          {socioSinCorreo
            ? 'Este socio entró sin correo. Ponle su email y podrá activar su cuenta desde “Ya soy socio”.'
            : 'Cambia el correo del socio — el de acceso (login) y el de la ficha, juntos.'}
        </span>
      </label>
      <label className="ek-label">
        Teléfono
        <input
          type="tel"
          value={telefono}
          onChange={(e) => setTelefono(e.target.value)}
          className="ek-input"
          placeholder="+52 667 123 4567"
        />
      </label>
      <label className="ek-label">
        Fecha de nacimiento{calcularEdad(fechaNac) != null ? ` · ${calcularEdad(fechaNac)} años` : ''}
        <input
          type="date"
          value={fechaNac}
          onChange={(e) => setFechaNac(e.target.value)}
          className="ek-input"
        />
      </label>
      <label className="ek-label">
        Sexo
        <select value={sexo} onChange={(e) => setSexo(e.target.value)} className="ek-input">
          <option value="">Sin especificar</option>
          <option value="femenino">Femenino</option>
          <option value="masculino">Masculino</option>
          <option value="otro">Otro</option>
        </select>
      </label>
      <label className="ek-label" style={{ gridColumn: '1 / -1' }}>
        Domicilio
        <input
          type="text"
          value={domicilio}
          onChange={(e) => setDomicilio(e.target.value)}
          className="ek-input"
          placeholder="Calle, número, colonia, ciudad"
        />
      </label>
      {multisede && (
        <label className="ek-label">
          Sede
          <select
            value={sucursalId}
            onChange={(e) => setSucursalId(e.target.value)}
            className="ek-input"
          >
            <option value="">Sin asignar</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>{s.nombre}</option>
            ))}
          </select>
          <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>
            Sede "home" del socio. La app del socio abre por defecto en esta sede (puede cambiarla).
          </span>
        </label>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.75rem', gridColumn: '1 / -1' }}>
        <button onClick={handleSave} disabled={saving || !isDirty} className="ek-cta">
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </button>
        {saved && <span style={{ color: 'var(--sala-success)', fontSize: '0.875rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Check size={14} strokeWidth={2.5} />Guardado</span>}
        {error && <span style={{ color: 'var(--sala-error)', fontSize: '0.875rem' }}>{error}</span>}
      </div>
    </div>
  );
}

function ResetPasswordControl({ usuarioId }: { usuarioId: string }) {
  const [sending, setSending] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleReset() {
    if (!confirm(`¿Restablecer la contraseña de este socio a la temporal (${PASSWORD_TEMPORAL_INICIAL})?`)) return;
    setSending(true);
    setError(null);
    try {
      const res = await backendPost<{ password: string }>('reception-reset-password', { usuario_id: usuarioId });
      setPassword(res.password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos resetear la contraseña. Prueba de nuevo.');
    }
    setSending(false);
  }

  if (password) {
    return (
      <div style={{ marginTop: '0.25rem' }}>
        <p style={{ fontSize: '0.8125rem', color: 'var(--sala-text-secondary)', margin: '0 0 6px' }}>
          Contraseña temporal (dásela al socio; la cambia al entrar):
        </p>
        <code style={{ fontFamily: 'var(--ek-font-mono)', fontSize: '18px', fontWeight: 800, letterSpacing: '0.08em', color: 'var(--sala-text-primary)' }}>
          {password}
        </code>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
      <button onClick={handleReset} disabled={sending} className="ek-cta ek-cta--secondary">
        {sending ? 'Reseteando…' : 'Resetear contraseña'}
      </button>
      {error && <span style={{ color: 'var(--sala-error)', fontSize: '0.875rem' }}>{error}</span>}
    </div>
  );
}
