import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMiembros } from '../hooks/useAdminData';
import { NuevaPersonaModal } from '../components/NuevaPersonaModal';
import CardMenuDropdown from '../components/CardMenuDropdown';
import { CambiarPlanModal } from '../components/miembro/CambiarPlanModal';
import { BloquearAccesoModal } from '../components/miembro/BloquearAccesoModal';
import type { Database } from '@shared/types/database';

type MiembroLista = Database['public']['Tables']['usuarios']['Row'];

export default function Miembros() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('');
  const [showNuevo, setShowNuevo] = useState(false);
  const [cambiarPlanFor, setCambiarPlanFor] = useState<MiembroLista | null>(null);
  const [bloquearFor, setBloquearFor] = useState<MiembroLista | null>(null);
  // Fijamos rol='miembro' para excluir staff (admins, recepcionistas).
  // El equipo se gestiona desde /admin/equipo (Sprint Equipo).
  const { miembros, isLoading, refetch } = useMiembros({ search, status, rol: 'miembro' });

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}
      >
        <div>
          <p className="ek-eyebrow">MIEMBROS</p>
          <h1 className="ek-h2">Tus clientes en SALA</h1>
          {!isLoading && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '4px' }}>
              {miembros.length}{' '}
              {miembros.length === 1 ? 'cliente' : 'clientes'}
            </p>
          )}
        </div>
        <button onClick={() => setShowNuevo(true)} className="ek-cta">
          + Nuevo miembro
        </button>
      </div>

      <div className="adm-filters">
        <input
          type="text"
          placeholder="Buscar por nombre o email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ek-input"
          style={{ maxWidth: '280px' }}
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="ek-input"
          style={{ maxWidth: '180px' }}
        >
          <option value="">Todos los status</option>
          <option value="activo">Activo</option>
          <option value="pendiente_onboarding">Pendiente onboarding</option>
          <option value="pendiente_pago">Pendiente pago</option>
          <option value="suspendido">Suspendido</option>
          <option value="cancelado">Cancelado</option>
        </select>
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : miembros.length === 0 ? (
        <EmptyMiembros search={search} status={status} onClear={() => { setSearch(''); setStatus(''); }} onNuevo={() => setShowNuevo(true)} />
      ) : (
        <div className="adm-table-wrapper">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Email</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Alta</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {miembros.map((m) => {
                const estaBloqueado =
                  !!m.bloqueado_hasta && new Date(m.bloqueado_hasta) > new Date();
                return (
                  <tr key={m.id}>
                    <td>{m.nombre ?? '—'}</td>
                    <td style={{ color: 'var(--ek-ink-muted)' }}>{m.email}</td>
                    <td>{m.membresia_tier ?? '—'}</td>
                    <td>
                      <StatusBadge status={m.status} />
                    </td>
                    <td style={{ fontSize: '0.8125rem', color: 'var(--ek-ink-muted)' }}>
                      {new Date(m.created_at).toLocaleDateString('es-MX')}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <CardMenuDropdown
                        items={[
                          {
                            label: 'Ver perfil',
                            icon: '👤',
                            onClick: () => navigate(`/admin/miembros/${m.id}`)
                          },
                          {
                            label: 'Cambiar plan',
                            icon: '💳',
                            onClick: () => setCambiarPlanFor(m),
                            divider: true
                          },
                          {
                            label: estaBloqueado ? 'Desbloquear acceso' : 'Bloquear acceso',
                            icon: estaBloqueado ? '🔓' : '🔒',
                            onClick: () => setBloquearFor(m),
                            danger: !estaBloqueado
                          }
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showNuevo && (
        <NuevaPersonaModal
          onClose={() => setShowNuevo(false)}
          onCreated={async () => {
            await refetch();
            setShowNuevo(false);
          }}
        />
      )}

      {cambiarPlanFor && (
        <CambiarPlanModal
          usuarioId={cambiarPlanFor.id}
          nombreMiembro={cambiarPlanFor.nombre ?? cambiarPlanFor.email}
          tierActualSlug={cambiarPlanFor.membresia_tier}
          onClose={() => setCambiarPlanFor(null)}
          onSaved={async () => {
            await refetch();
          }}
        />
      )}

      {bloquearFor && (
        <BloquearAccesoModal
          usuarioId={bloquearFor.id}
          nombreMiembro={bloquearFor.nombre ?? bloquearFor.email}
          bloqueadoHasta={
            bloquearFor.bloqueado_hasta && new Date(bloquearFor.bloqueado_hasta) > new Date()
              ? new Date(bloquearFor.bloqueado_hasta)
              : null
          }
          onClose={() => setBloquearFor(null)}
          onSaved={async () => {
            await refetch();
          }}
        />
      )}
    </div>
  );
}

function EmptyMiembros({
  search,
  status,
  onClear,
  onNuevo
}: {
  search: string;
  status: string;
  onClear: () => void;
  onNuevo: () => void;
}) {
  const tieneFiltros = !!search || !!status;
  return (
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
        {tieneFiltros ? 'Sin coincidencias' : 'Sin miembros todavía'}
      </p>
      <h2
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
        {tieneFiltros
          ? 'No encontramos miembros con esos filtros.'
          : 'Tu base de miembros está vacía.'}
      </h2>
      <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0, marginBottom: '20px' }}>
        {tieneFiltros
          ? 'Probá cambiar la búsqueda o el status.'
          : 'Invitá al primero y empezá a llenar tu gimnasio.'}
      </p>
      {tieneFiltros ? (
        <button onClick={onClear} className="ek-cta ek-cta--secondary">Limpiar filtros</button>
      ) : (
        <button onClick={onNuevo} className="ek-cta">+ Nuevo miembro</button>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    activo: 'var(--ek-success)',
    pendiente_onboarding: 'var(--ek-warning)',
    pendiente_pago: 'var(--ek-warning)',
    suspendido: 'var(--ek-danger)',
    cancelado: 'var(--ek-ink-muted)'
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.8125rem' }}>
      <span
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: colorMap[status] ?? 'var(--ek-ink-muted)'
        }}
      />
      {status.replace(/_/g, ' ')}
    </span>
  );
}
