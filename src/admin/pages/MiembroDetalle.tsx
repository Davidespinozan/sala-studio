import { useParams, Link, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check } from 'lucide-react';
import {
  useMiembroDetalle,
  useTiersAdmin,
  adminUpdateRole,
  adminDeleteUser
} from '../hooks/useAdminData';
import { useMiembroKPIs } from '../hooks/useMiembroKPIs';
import { useSucursal } from '../providers/SucursalProvider';
import { supabase } from '@shared/lib/supabase';
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
import { MiembroNotasInternas } from '../components/miembro/MiembroNotasInternas';
import { GestionarMembresiaModal } from '../components/miembro/GestionarMembresiaModal';
import { BloquearAccesoModal } from '../components/miembro/BloquearAccesoModal';
import type { Database } from '@shared/types/database';

type Recurso = Pick<Database['public']['Tables']['recursos']['Row'], 'nombre'>;

export default function MiembroDetalle() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { miembro, reservas, isLoading, refetch } = useMiembroDetalle(id);
  const { tiers } = useTiersAdmin();
  const { kpis, isLoading: loadingKpis, refetch: refetchKpis } = useMiembroKPIs(id);

  // Membresía activa para "vence en X días" + saldo de créditos (si aplica).
  const [periodoFin, setPeriodoFin] = useState<Date | null>(null);
  const [creditosRestantes, setCreditosRestantes] = useState<number | null>(null);
  useEffect(() => {
    if (!id) return;
    let mounted = true;
    void (async () => {
      const { data } = await supabase
        .from('membresias')
        .select('periodo_actual_fin, creditos_restantes, tier:tiers(tipo)')
        .eq('usuario_id', id)
        .eq('status', 'activa')
        .order('periodo_actual_fin', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!mounted) return;
      const fin = (data?.periodo_actual_fin as string | undefined) ?? null;
      setPeriodoFin(fin ? new Date(fin) : null);
      const tipo = (data?.tier as { tipo?: string } | null)?.tipo;
      const cred = (data?.creditos_restantes as number | null) ?? null;
      // Solo planes por créditos/híbrido tienen saldo que mostrar.
      setCreditosRestantes(tipo === 'creditos' || tipo === 'hibrido' ? cred : null);
    })();
    return () => { mounted = false; };
  }, [id, miembro]);

  const [showCambiarPlan, setShowCambiarPlan] = useState(false);
  const [showBloquear, setShowBloquear] = useState(false);
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

  const planNombre = miembro.membresia_tier
    ? tiers.find((t) => t.slug === miembro.membresia_tier)?.nombre ?? null
    : null;

  const diasParaVencimiento = periodoFin
    ? Math.ceil((periodoFin.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : null;

  const bloqueadoHasta =
    miembro.bloqueado_hasta && new Date(miembro.bloqueado_hasta) > new Date()
      ? new Date(miembro.bloqueado_hasta)
      : null;

  async function handleAfterChange() {
    await Promise.all([refetch(), refetchKpis()]);
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

          <FieldGroup title="Cuenta">
            <ResetPasswordControl email={miembro.email} />
          </FieldGroup>

          <FieldGroup title="Información del sistema">
            <div className="adm-info-grid">
              <Info label="Email" value={miembro.email} />
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
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDirty =
    nombre !== (miembro.nombre ?? '') ||
    telefono !== (miembro.telefono ?? '') ||
    sucursalId !== (miembro.sucursal_id ?? '');

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const { error } = await supabase
        .from('usuarios')
        .update({
          nombre: nombre.trim() || null,
          telefono: telefono.trim() || null,
          sucursal_id: sucursalId || null
        })
        .eq('id', miembro.id);
      if (error) throw error;
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
        Teléfono
        <input
          type="tel"
          value={telefono}
          onChange={(e) => setTelefono(e.target.value)}
          className="ek-input"
          placeholder="+52 667 123 4567"
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

function ResetPasswordControl({ email }: { email: string }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReset() {
    if (!confirm(`¿Enviar email de recuperación de contraseña a ${email}?`)) return;
    setSending(true);
    setError(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/login`
      });
      if (error) throw error;
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos enviar el email. Prueba de nuevo.');
    }
    setSending(false);
  }

  if (sent) {
    return (
      <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: 'var(--sala-success)', display: 'flex', alignItems: 'center', gap: '5px' }}>
        <Check size={14} strokeWidth={2.5} style={{ flexShrink: 0 }} />
        Email de recuperación enviado a {email}
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
      <button onClick={handleReset} disabled={sending} className="ek-cta ek-cta--secondary">
        {sending ? 'Enviando…' : 'Enviar email de recuperación'}
      </button>
      {error && <span style={{ color: 'var(--sala-error)', fontSize: '0.875rem' }}>{error}</span>}
    </div>
  );
}
