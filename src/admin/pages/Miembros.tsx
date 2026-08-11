import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { User, CreditCard, Lock, Unlock } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useMiembros } from '../hooks/useAdminData';
import { InfoTooltip } from '../components/InfoTooltip';
import { NuevaPersonaModal } from '../components/NuevaPersonaModal';
import { ImportarMiembrosModal } from '../components/ImportarMiembrosModal';
import { exportarCsv } from '@shared/lib/exportarCsv';
import { etiquetaCorreo, esCorreoMarcador } from '@shared/lib/sinCorreo';
import CardMenuDropdown from '../components/CardMenuDropdown';
import { GestionarMembresiaModal } from '../components/miembro/GestionarMembresiaModal';
import { BloquearAccesoModal } from '../components/miembro/BloquearAccesoModal';
import type { Database } from '@shared/types/database';

type MiembroLista = Database['public']['Tables']['usuarios']['Row'];

/** Última membresía de cada socio (para la columna "Membresía" de la tabla). */
interface UltimaMembresia {
  status: string;
  fin: string | null;
}

export default function Miembros() {
  const tenant = useTenant();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  // Permite llegar pre-filtrado desde el Centro de pendientes (?status=pendiente_pago).
  const [status, setStatus] = useState<string>(() => searchParams.get('status') ?? '');
  const [showNuevo, setShowNuevo] = useState(false);
  const [showImportar, setShowImportar] = useState(false);
  const [cambiarPlanFor, setCambiarPlanFor] = useState<MiembroLista | null>(null);
  const [bloquearFor, setBloquearFor] = useState<MiembroLista | null>(null);
  // Fijamos rol='miembro' para excluir staff (admins, recepcionistas).
  // El equipo se gestiona desde /admin/equipo (Sprint Equipo).
  const { miembros, isLoading, refetch } = useMiembros({ search, status, rol: 'miembro' });
  // "Sin correo": socios importados sin email real → recepción debe capturarlo.
  const [soloSinCorreo, setSoloSinCorreo] = useState(false);
  const sinCorreoCount = miembros.filter((m) => esCorreoMarcador(m.email)).length;
  const visibles = soloSinCorreo ? miembros.filter((m) => esCorreoMarcador(m.email)) : miembros;
  // "Vigentes" = con plan o paquete activo (cache membresia_activa_id). El resto
  // son registrados que hoy no tienen nada: day passes de una visita, bajas, etc.
  const vigentesCount = miembros.filter((m) => m.status === 'activo' && m.membresia_activa_id).length;

  // Última membresía por socio, para que la columna "Membresía" distinga
  // "Vencida" (tuvo algo y se le terminó) de "Sin plan" (nunca ha tenido).
  const [ultimas, setUltimas] = useState<Map<string, UltimaMembresia>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from('membresias')
        .select('usuario_id, status, periodo_actual_fin')
        .eq('tenant_id', tenant.id)
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (error) { console.error('[Miembros] membresias', error); return; }
      const map = new Map<string, UltimaMembresia>();
      for (const r of data ?? []) {
        if (!map.has(r.usuario_id)) map.set(r.usuario_id, { status: r.status, fin: r.periodo_actual_fin });
      }
      setUltimas(map);
    })();
    return () => { cancelled = true; };
  }, [tenant.id, miembros]);

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: '12px' }}
      >
        <div>
          <p className="ek-eyebrow">MIEMBROS</p>
          <h1 className="ek-h2">Tus clientes en {tenant.nombre || 'tu gym'}</h1>
          {!isLoading && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '4px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span>
                {miembros.length} {miembros.length === 1 ? 'cliente' : 'clientes'} · {vigentesCount} con plan o paquete vigente
              </span>
              {sinCorreoCount > 0 && (
                <button
                  type="button"
                  onClick={() => setSoloSinCorreo((v) => !v)}
                  style={{
                    cursor: 'pointer', border: 'none', borderRadius: 999, padding: '2px 10px', fontSize: 11.5, fontWeight: 700,
                    background: soloSinCorreo ? 'var(--ek-warning, #d97706)' : 'var(--ek-warning-soft, rgba(217,119,6,.14))',
                    color: soloSinCorreo ? '#fff' : 'var(--ek-warning, #d97706)'
                  }}
                  title="Estos socios entraron sin correo. Ponles su email en la ficha para que activen su cuenta."
                >
                  {sinCorreoCount} sin correo {soloSinCorreo ? '· ver todos' : '›'}
                </button>
              )}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => exportarCsv(`miembros-${tenant.slug || 'gym'}`, miembros, [
              { key: 'nombre', label: 'Nombre' },
              { key: 'email', label: 'Email', valor: (m) => etiquetaCorreo(m.email) },
              { key: 'telefono', label: 'Teléfono' },
              { key: 'status', label: 'Estado' },
              { key: 'membresia_tier', label: 'Plan' },
              { key: 'created_at', label: 'Miembro desde', valor: (m) => (m.created_at ? new Date(m.created_at).toLocaleDateString('es-MX') : '') }
            ])}
            className="ek-cta ek-cta--secondary"
            disabled={miembros.length === 0}
          >
            Exportar CSV
          </button>
          <button onClick={() => setShowImportar(true)} className="ek-cta ek-cta--secondary">
            Importar CSV
          </button>
          <button onClick={() => setShowNuevo(true)} className="ek-cta">
            + Nuevo miembro
          </button>
        </div>
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
                <th>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    Membresía
                    <InfoTooltip
                      titulo="Membresía"
                      texto="Si su plan o paquete sigue vigente hoy."
                      align="right"
                    />
                  </span>
                </th>
                <th>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    Status
                    <InfoTooltip
                      titulo="Status"
                      texto="Si su cuenta puede entrar a la app. No dice nada del plan — eso es Membresía."
                      align="right"
                    />
                  </span>
                </th>
                <th>Alta</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((m) => {
                const estaBloqueado =
                  !!m.bloqueado_hasta && new Date(m.bloqueado_hasta) > new Date();
                return (
                  <tr key={m.id}>
                    <td>{m.nombre ?? '—'}</td>
                    <td style={{ color: 'var(--ek-ink-muted)' }}>
                      {esCorreoMarcador(m.email) ? (
                        <span style={{ display: 'inline-block', borderRadius: 999, padding: '1px 9px', fontSize: 11.5, fontWeight: 700, background: 'var(--ek-warning-soft, rgba(217,119,6,.14))', color: 'var(--ek-warning, #d97706)' }}>
                          Sin correo
                        </span>
                      ) : m.email}
                    </td>
                    <td>{m.membresia_tier ?? '—'}</td>
                    <td>
                      <MembresiaBadge ultima={ultimas.get(m.id)} />
                    </td>
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
                            icon: <User size={15} />,
                            onClick: () => navigate(`/admin/miembros/${m.id}`)
                          },
                          {
                            label: 'Cambiar plan',
                            icon: <CreditCard size={15} />,
                            onClick: () => setCambiarPlanFor(m),
                            divider: true
                          },
                          {
                            label: estaBloqueado ? 'Desbloquear acceso' : 'Bloquear acceso',
                            icon: estaBloqueado ? <Unlock size={15} /> : <Lock size={15} />,
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

      {showImportar && (
        <ImportarMiembrosModal
          onClose={() => setShowImportar(false)}
          onImported={() => { void refetch(); }}
        />
      )}

      {cambiarPlanFor && (
        <GestionarMembresiaModal
          usuarioId={cambiarPlanFor.id}
          nombreMiembro={cambiarPlanFor.nombre ?? cambiarPlanFor.email}
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
          ? 'Prueba cambiar la búsqueda o el status.'
          : 'Invita al primero y empieza a llenar tu gimnasio.'}
      </p>
      {tieneFiltros ? (
        <button onClick={onClear} className="ek-cta ek-cta--secondary">Limpiar filtros</button>
      ) : (
        <button onClick={onNuevo} className="ek-cta">+ Nuevo miembro</button>
      )}
    </div>
  );
}

/**
 * Estado de la MEMBRESÍA (no de la cuenta): Vigente / Pausada / Vencida (con
 * fecha) / Sin plan. Deriva "vencida" por FECHA aunque la base diga 'activa'
 * (misma defensa que las fichas: el cron puede ir atrasado).
 */
function MembresiaBadge({ ultima }: { ultima?: UltimaMembresia }) {
  let label = 'Sin plan';
  let color = 'var(--ek-ink-muted)';
  if (ultima) {
    const activa = ['activa', 'trialing', 'past_due'].includes(ultima.status);
    const finPasado = !!ultima.fin && new Date(ultima.fin).getTime() < Date.now();
    if (ultima.status === 'congelada') {
      label = 'Pausada';
      color = 'var(--ek-warning)';
    } else if (activa && !finPasado) {
      label = 'Vigente';
      color = 'var(--ek-success)';
    } else if ((activa && finPasado) || ultima.status === 'expirada' || ultima.status === 'cancelada') {
      label = ultima.fin
        ? `Vencida · ${new Date(ultima.fin).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}`
        : 'Vencida';
      color = 'var(--ek-danger)';
    }
    // 'pendiente' u otros → se queda en "Sin plan" (todavía no tiene nada usable).
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>
      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: color }} />
      {label}
    </span>
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
