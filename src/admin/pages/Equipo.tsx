import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCcw, Ban, AlertTriangle, KeyRound } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { backendPost } from '@shared/lib/backend';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { useSucursal } from '../providers/SucursalProvider';
import { canModifyTeamMember, revokeTeamMember } from '../lib/crudHelpers';
import { adminDeleteUser } from '../hooks/useAdminData';
import CardMenuDropdown from '../components/CardMenuDropdown';
import ConfirmDialog from '../components/ConfirmDialog';
import CrearAccesoModal, { type CredencialesCreadas } from '../components/CrearAccesoModal';
import CredencialesCreadasModal from '../components/CredencialesCreadasModal';
import CambiarRolModal from '../components/CambiarRolModal';
import type { Database } from '@shared/types/database';

import { COLUMNAS_USUARIO_CLIENTE } from '@shared/lib/usuariosSelect';

type Usuario = Database['public']['Tables']['usuarios']['Row'];
type RolStaff = 'admin' | 'recepcionista';

function capitalizar(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function rolLabel(rol: string): string {
  if (rol === 'admin') return 'Administrador';
  if (rol === 'recepcionista') return 'Recepcionista';
  return rol;
}

type RevokeState = null | { usuario: Usuario; status: 'loading' | 'blocked'; reason?: string } | { usuario: Usuario; status: 'ready' };

export default function Equipo() {
  const tenant = useTenant();
  const { usuario: currentUser } = useAuth();
  const { sucursales, multisede } = useSucursal();
  const toast = useToast();

  async function asignarSucursal(u: Usuario, sucursalId: string) {
    const { error } = await supabase
      .from('usuarios')
      .update({ sucursal_id: sucursalId })
      .eq('id', u.id);
    if (error) {
      toast.error('No pudimos cambiar la sede. Prueba de nuevo.');
      return;
    }
    toast.success('Sede actualizada.');
    await refetch();
  }

  const [staff, setStaff] = useState<Usuario[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCrearAcceso, setShowCrearAcceso] = useState(false);
  const [credencialesCreadas, setCredencialesCreadas] = useState<CredencialesCreadas | null>(null);
  const [cambioRol, setCambioRol] = useState<{ usuario: Usuario; rol: RolStaff } | null>(null);
  const [revoke, setRevoke] = useState<RevokeState>(null);
  const [eliminar, setEliminar] = useState<Usuario | null>(null);
  const [eliminando, setEliminando] = useState(false);
  const [resetPwd, setResetPwd] = useState<{ nombre: string; password: string } | null>(null);

  async function handleResetPassword(u: Usuario) {
    try {
      const res = await backendPost<{ password: string }>('reception-reset-password', { usuario_id: u.id });
      setResetPwd({ nombre: capitalizar(u.nombre) || u.email, password: res.password });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No pudimos resetear la contraseña.');
    }
  }

  const refetch = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from('usuarios')
      .select(COLUMNAS_USUARIO_CLIENTE)
      .eq('tenant_id', tenant.id)
      .in('rol', ['admin', 'recepcionista'])
      .neq('status', 'revocado')
      .order('rol', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[Equipo]', error);
      toast.error('No pudimos cargar el equipo. Prueba recargar la página.');
      setIsLoading(false);
      return;
    }
    setStaff((data as unknown as Usuario[]) ?? []);
    setIsLoading(false);
  }, [tenant.id, toast]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const { admins, recepcionistas } = useMemo(() => {
    const admins: Usuario[] = [];
    const recepcionistas: Usuario[] = [];

    staff.forEach((u) => {
      if (u.rol === 'admin') admins.push(u);
      else if (u.rol === 'recepcionista') recepcionistas.push(u);
    });

    return { admins, recepcionistas };
  }, [staff]);

  const conAcceso = admins.length + recepcionistas.length;

  async function startRevoke(u: Usuario) {
    if (!currentUser) return;
    setRevoke({ usuario: u, status: 'loading' });
    const check = await canModifyTeamMember(
      u.id,
      currentUser.id,
      u.rol as RolStaff,
      'revoke',
      tenant.id
    );
    if (!check.canModify) {
      setRevoke({ usuario: u, status: 'blocked', reason: check.reason });
    } else {
      setRevoke({ usuario: u, status: 'ready' });
    }
  }

  async function handleRevoke() {
    if (!revoke || revoke.status !== 'ready') return;
    const { error } = await revokeTeamMember(revoke.usuario.id);
    if (error) {
      toast.error('No pudimos revocar el acceso. Prueba de nuevo.');
      return;
    }
    toast.success(`Acceso revocado para ${capitalizar(revoke.usuario.nombre) || revoke.usuario.email}.`);
    setRevoke(null);
    await refetch();
  }

  async function handleEliminar() {
    if (!eliminar) return;
    setEliminando(true);
    const { data, error } = await adminDeleteUser({ usuarioId: eliminar.id });
    setEliminando(false);
    if (error) {
      toast.error(error.error);
      setEliminar(null);
      return;
    }
    toast.success(`${data.email} eliminado. El email queda liberado para re-uso.`);
    setEliminar(null);
    await refetch();
  }

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}
      >
        <div>
          <p className="ek-eyebrow">EQUIPO</p>
          <h1 className="ek-h2">Personas con acceso al panel de {tenant.nombre || 'tu gym'}</h1>
          {!isLoading && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '4px' }}>
              {conAcceso} {conAcceso === 1 ? 'persona con acceso' : 'personas con acceso'}
            </p>
          )}
        </div>
        <button onClick={() => setShowCrearAcceso(true)} className="ek-cta">
          + Crear acceso
        </button>
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : (
        <div className="adm-stack" style={{ gap: '32px' }}>
          {admins.length > 0 && (
            <Section title="ADMINISTRADORES">
              {admins.map((u) => (
                <PersonaCard
                  key={u.id}
                  usuario={u}
                  currentUserId={currentUser?.id}
                  onCambiarRol={() => setCambioRol({ usuario: u, rol: 'admin' })}
                  onRevoke={() => startRevoke(u)}
                  onEliminar={() => setEliminar(u)}
                  onResetPassword={() => handleResetPassword(u)}
                />
              ))}
            </Section>
          )}

          {recepcionistas.length > 0 && (
            <Section title="RECEPCIONISTAS">
              {recepcionistas.map((u) => (
                <PersonaCard
                  key={u.id}
                  usuario={u}
                  currentUserId={currentUser?.id}
                  sucursales={multisede ? sucursales.map((s) => ({ id: s.id, nombre: s.nombre })) : undefined}
                  onChangeSucursal={(id) => asignarSucursal(u, id)}
                  onCambiarRol={() => setCambioRol({ usuario: u, rol: 'recepcionista' })}
                  onRevoke={() => startRevoke(u)}
                  onEliminar={() => setEliminar(u)}
                  onResetPassword={() => handleResetPassword(u)}
                />
              ))}
            </Section>
          )}

          {admins.length === 0 && recepcionistas.length === 0 && (
            <div
              style={{
                padding: '48px 20px',
                textAlign: 'center',
                background: 'var(--sala-surface)',
                border: '1px solid var(--sala-border)',
                borderRadius: '14px'
              }}
            >
              <p
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: 'var(--sala-text-tertiary)',
                  margin: 0,
                  marginBottom: '8px'
                }}
              >
                Sin equipo todavía
              </p>
              <h3
                style={{
                  fontFamily: 'var(--ek-font-display)',
                  fontSize: '18px',
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  color: 'var(--sala-text-primary)',
                  margin: 0,
                  marginBottom: '14px'
                }}
              >
                Eres el único con acceso al sistema.
              </h3>
              <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, marginBottom: '20px' }}>
                Invita recepcionistas u otros admins para gestionar el día a día.
              </p>
              <button onClick={() => setShowCrearAcceso(true)} className="ek-cta">
                + Crear acceso
              </button>
            </div>
          )}
        </div>
      )}

      {showCrearAcceso && (
        <CrearAccesoModal
          onClose={() => setShowCrearAcceso(false)}
          onSuccess={async (cred) => {
            setCredencialesCreadas(cred);
            await refetch();
          }}
        />
      )}

      {credencialesCreadas && (
        <CredencialesCreadasModal
          isOpen={true}
          credenciales={credencialesCreadas}
          onClose={() => setCredencialesCreadas(null)}
        />
      )}

      {cambioRol && (
        <CambiarRolModal
          usuarioId={cambioRol.usuario.id}
          nombre={capitalizar(cambioRol.usuario.nombre) || cambioRol.usuario.email}
          rolActual={cambioRol.rol}
          onClose={() => setCambioRol(null)}
          onSaved={async () => {
            await refetch();
          }}
        />
      )}

      <ConfirmDialog
        isOpen={revoke !== null}
        title={revoke ? `¿Revocar acceso de ${capitalizar(revoke.usuario.nombre) || revoke.usuario.email}?` : ''}
        description={
          revoke?.status === 'loading'
            ? 'Verificando permisos…'
            : revoke?.status === 'blocked'
            ? revoke.reason ?? 'No se puede revocar.'
            : 'No podrá entrar al sistema. Sus datos quedan en BD para auditoría. Puedes restaurar el acceso después.'
        }
        confirmLabel="Revocar acceso"
        variant={revoke?.status === 'blocked' ? 'danger' : 'warning'}
        hideConfirm={revoke?.status !== 'ready'}
        requireTypedConfirmation={revoke?.status === 'ready' ? 'REVOCAR' : undefined}
        onConfirm={handleRevoke}
        onCancel={() => setRevoke(null)}
      />

      <ConfirmDialog
        isOpen={eliminar !== null}
        title={eliminar ? `¿Eliminar definitivamente a ${capitalizar(eliminar.nombre) || eliminar.email}?` : ''}
        description={
          eliminar
            ? `Acción permanente. El email "${eliminar.email}" queda liberado para re-uso inmediato. Si tiene reservas en historial, tendrás que cancelarlas o usar "Revocar acceso" en su lugar. Escribe ELIMINAR para confirmar.`
            : ''
        }
        confirmLabel={eliminando ? 'Eliminando…' : 'Eliminar definitivamente'}
        variant="danger"
        requireTypedConfirmation="ELIMINAR"
        onConfirm={handleEliminar}
        onCancel={() => !eliminando && setEliminar(null)}
      />

      {resetPwd && (
        <div className="ek-modal-backdrop" onClick={() => setResetPwd(null)}>
          <div className="ek-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420, textAlign: 'center' }}>
            <div className="ek-modal-handle" />
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>CONTRASEÑA RESTABLECIDA</p>
            <h3 className="ek-h3" style={{ margin: '6px 0 10px' }}>{resetPwd.nombre}</h3>
            <p style={{ fontSize: 13, color: 'var(--sala-text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
              Pásale esta contraseña temporal. Al entrar deberá cambiarla por una suya.
            </p>
            <div style={{ background: 'var(--sala-surface)', border: '0.5px solid var(--sala-border)', borderRadius: 12, padding: '14px 16px', marginBottom: 16 }}>
              <p style={{ fontFamily: 'var(--ek-font-mono)', fontSize: 26, fontWeight: 800, letterSpacing: '0.08em', margin: 0, color: 'var(--sala-text-primary)' }}>{resetPwd.password}</p>
            </div>
            <button type="button" onClick={() => setResetPwd(null)} className="ek-cta" style={{ width: '100%' }}>
              Listo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p
        className="ek-eyebrow ek-eyebrow--mustard"
        style={{ marginBottom: '12px', fontSize: '11px' }}
      >
        {title}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>{children}</div>
    </section>
  );
}

function PersonaCard({
  usuario: u,
  currentUserId,
  sucursales,
  onChangeSucursal,
  onCambiarRol,
  onRevoke,
  onEliminar,
  onResetPassword
}: {
  usuario: Usuario;
  currentUserId: string | undefined;
  sucursales?: { id: string; nombre: string }[];
  onChangeSucursal?: (sucursalId: string) => void;
  onCambiarRol: () => void;
  onRevoke: () => void;
  onEliminar: () => void;
  onResetPassword: () => void;
}) {
  const esYo = u.id === currentUserId;
  const nombre = capitalizar(u.nombre) || u.email;

  return (
    <div
      style={{
        background: 'var(--ek-bg-soft)',
        border: '0.5px solid var(--ek-line)',
        borderRadius: '16px',
        padding: '16px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: '16px'
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '17px',
            fontWeight: 600,
            margin: 0,
            marginBottom: '2px',
            color: 'var(--ek-ink)',
            letterSpacing: '-0.02em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {nombre}
          {esYo && (
            <span
              style={{
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.1em',
                color: 'var(--ek-mustard)',
                marginLeft: '8px'
              }}
            >
              (TÚ)
            </span>
          )}
        </h3>
        <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '2px' }}>
          {u.email}
        </p>
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: 0 }}>
          {rolLabel(u.rol)}
          {u.status !== 'activo' && ` · status: ${u.status}`}
        </p>
        {sucursales && onChangeSucursal && (
          <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>Sede:</span>
            <select
              value={u.sucursal_id ?? ''}
              onChange={(e) => e.target.value && onChangeSucursal(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              className="ek-input"
              style={{ fontSize: '12px', padding: '4px 8px', height: 'auto', width: 'auto', maxWidth: '200px' }}
            >
              <option value="">Sin asignar</option>
              {sucursales.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nombre}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <CardMenuDropdown
        items={[
          { label: 'Cambiar rol', icon: <RefreshCcw size={15} />, onClick: onCambiarRol },
          { label: 'Resetear contraseña', icon: <KeyRound size={15} />, onClick: onResetPassword },
          { label: 'Revocar acceso', icon: <Ban size={15} />, onClick: onRevoke, danger: true, divider: true },
          ...(esYo ? [] : [
            { label: 'Eliminar definitivamente', icon: <AlertTriangle size={15} />, onClick: onEliminar, danger: true }
          ])
        ]}
      />
    </div>
  );
}

