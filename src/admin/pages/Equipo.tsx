import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { canModifyTeamMember, revokeTeamMember } from '../lib/crudHelpers';
import CardMenuDropdown from '../components/CardMenuDropdown';
import ConfirmDialog from '../components/ConfirmDialog';
import CrearAccesoModal, { type CredencialesCreadas } from '../components/CrearAccesoModal';
import CredencialesCreadasModal from '../components/CredencialesCreadasModal';
import CambiarRolModal from '../components/CambiarRolModal';
import type { Database } from '@shared/types/database';

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
  const toast = useToast();

  const [staff, setStaff] = useState<Usuario[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCrearAcceso, setShowCrearAcceso] = useState(false);
  const [credencialesCreadas, setCredencialesCreadas] = useState<CredencialesCreadas | null>(null);
  const [cambioRol, setCambioRol] = useState<{ usuario: Usuario; rol: RolStaff } | null>(null);
  const [revoke, setRevoke] = useState<RevokeState>(null);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from('usuarios')
      .select('*')
      .eq('tenant_id', tenant.id)
      .in('rol', ['admin', 'recepcionista'])
      .neq('status', 'revocado')
      .order('rol', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[Equipo]', error);
      toast.error('No se pudo cargar el equipo.');
      setIsLoading(false);
      return;
    }
    setStaff(data ?? []);
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
      toast.error(`No se pudo revocar: ${error}`);
      return;
    }
    toast.success(`Acceso revocado para ${capitalizar(revoke.usuario.nombre) || revoke.usuario.email}.`);
    setRevoke(null);
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
          <h1 className="ek-h2">Personas con acceso a EKKO admin</h1>
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
                  onCambiarRol={() => setCambioRol({ usuario: u, rol: 'recepcionista' })}
                  onRevoke={() => startRevoke(u)}
                />
              ))}
            </Section>
          )}

          {admins.length === 0 && recepcionistas.length === 0 && (
            <p className="ek-body-faint" style={{ padding: '20px 0' }}>
              Sin personas con acceso todavía. Click en &quot;+ Crear acceso&quot; para empezar.
            </p>
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
  onCambiarRol,
  onRevoke
}: {
  usuario: Usuario;
  currentUserId: string | undefined;
  onCambiarRol: () => void;
  onRevoke: () => void;
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
      </div>
      <CardMenuDropdown
        items={[
          { label: 'Cambiar rol', icon: '🔄', onClick: onCambiarRol },
          { label: 'Revocar acceso', icon: '🚫', onClick: onRevoke, danger: true, divider: true }
        ]}
      />
    </div>
  );
}

