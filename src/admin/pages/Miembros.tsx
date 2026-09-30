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

/**
 * Estado de la membresía de un socio, mirando TODAS sus membresías (no solo la
 * última): si tiene algo vigente, está vigente — y es "pagada" si al menos una
 * de sus vigentes es de un plan con precio > $0. Así un socio con mensualidad
 * que además tomó una clase de prueba gratis no aparece como "gratis".
 */
type EstadoMembresia = 'vigente' | 'pausada' | 'vencida' | 'sin_plan';
interface ResumenMembresia {
  estado: EstadoMembresia;
  /** Solo si estado='vigente': ¿alguna vigente es de un plan con precio? */
  pagada: boolean;
  ultima: UltimaMembresia;
}

type FiltroMembresia = '' | 'vigente' | 'vigente_pagada' | 'vigente_gratis' | 'pausada' | 'vencida' | 'sin_plan';

const ACTIVAS = ['activa', 'trialing', 'past_due'];

function estadoDeUltima(u: UltimaMembresia, ahora: number): EstadoMembresia {
  const activa = ACTIVAS.includes(u.status);
  const finPasado = !!u.fin && new Date(u.fin).getTime() < ahora;
  if (u.status === 'congelada') return 'pausada';
  if (activa && !finPasado) return 'vigente';
  if ((activa && finPasado) || u.status === 'expirada' || u.status === 'cancelada') return 'vencida';
  return 'sin_plan'; // 'pendiente' u otros: todavía no tiene nada usable
}

function pasaFiltro(r: ResumenMembresia | undefined, f: FiltroMembresia): boolean {
  if (!f) return true;
  const estado = r?.estado ?? 'sin_plan';
  if (f === 'vigente_pagada') return estado === 'vigente' && !!r?.pagada;
  if (f === 'vigente_gratis') return estado === 'vigente' && !r?.pagada;
  return estado === f;
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
  // Filtro por MEMBRESÍA (vigencia), aparte del status de la cuenta.
  const [filtroMembresia, setFiltroMembresia] = useState<FiltroMembresia>('');
  // "Vigentes" = con plan o paquete activo (cache membresia_activa_id). El resto
  // son registrados que hoy no tienen nada: day passes de una visita, bajas, etc.
  const vigentesCount = miembros.filter((m) => m.status === 'activo' && m.membresia_activa_id).length;

  // Última membresía por socio, para que la columna "Membresía" distinga
  // "Vencida" (tuvo algo y se le terminó) de "Sin plan" (nunca ha tenido).
  const [resumenes, setResumenes] = useState<Map<string, ResumenMembresia>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from('membresias')
        .select('usuario_id, status, periodo_actual_fin, tiers(precio_centavos)')
        .eq('tenant_id', tenant.id)
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (error) { console.error('[Miembros] membresias', error); return; }
      const ahora = Date.now();
      const map = new Map<string, ResumenMembresia>();
      for (const r of data ?? []) {
        const u: UltimaMembresia = { status: r.status, fin: r.periodo_actual_fin };
        const tier = r.tiers as { precio_centavos: number } | null;
        const vigente = estadoDeUltima(u, ahora) === 'vigente';
        const conPrecio = (tier?.precio_centavos ?? 0) > 0;
        const prev = map.get(r.usuario_id);
        if (!prev) {
          // La primera que llega es la más reciente (orden desc).
          map.set(r.usuario_id, { estado: estadoDeUltima(u, ahora), pagada: vigente && conPrecio, ultima: u });
        } else if (vigente) {
          // Una más vieja pero todavía vigente (p. ej. la mensualidad debajo de una prueba).
          prev.estado = 'vigente';
          prev.pagada = prev.pagada || conPrecio;
        }
      }
      setResumenes(map);
    })();
    return () => { cancelled = true; };
  }, [tenant.id, miembros]);

  const visibles = miembros.filter(
    (m) => (!soloSinCorreo || esCorreoMarcador(m.email)) && pasaFiltro(resumenes.get(m.id), filtroMembresia)
  );
  const vigentesPagadasCount = miembros.filter((m) => {
    const r = resumenes.get(m.id);
    return r?.estado === 'vigente' && r.pagada;
  }).length;

  const menuDe = (m: MiembroLista) => {
    const estaBloqueado = !!m.bloqueado_hasta && new Date(m.bloqueado_hasta) > new Date();
    return [
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
    ];
  };

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
                {resumenes.size > 0 && ` (${vigentesPagadasCount} pagados)`}
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
        <select
          value={filtroMembresia}
          onChange={(e) => setFiltroMembresia(e.target.value as FiltroMembresia)}
          className="ek-input"
          style={{ maxWidth: '220px' }}
          aria-label="Filtrar por membresía"
        >
          <option value="">Todas las membresías</option>
          <option value="vigente">Vigente (todas)</option>
          <option value="vigente_pagada">Vigente · pagada</option>
          <option value="vigente_gratis">Vigente · gratis</option>
          <option value="pausada">Pausada</option>
          <option value="vencida">Vencida</option>
          <option value="sin_plan">Sin plan</option>
        </select>
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : visibles.length === 0 ? (
        <EmptyMiembros
          search={search}
          status={status || filtroMembresia || (soloSinCorreo ? 'sin_correo' : '')}
          onClear={() => { setSearch(''); setStatus(''); setFiltroMembresia(''); setSoloSinCorreo(false); }}
          onNuevo={() => setShowNuevo(true)}
        />
      ) : (
        <>
        <div className="solo-movil">
          {visibles.map((m) => (
            <div key={m.id} className="miembro-card">
              <button
                type="button"
                className="miembro-card-main"
                onClick={() => navigate(`/admin/miembros/${m.id}`)}
              >
                <p className="miembro-card-nombre">{m.nombre ?? '—'}</p>
                <p className="miembro-card-email">
                  {esCorreoMarcador(m.email) ? 'Sin correo' : m.email}
                </p>
                <div className="miembro-card-meta">
                  <MembresiaBadge resumen={resumenes.get(m.id)} />
                  {m.membresia_tier && <span>{m.membresia_tier}</span>}
                  {m.status !== 'activo' && <StatusBadge status={m.status} />}
                </div>
              </button>
              <CardMenuDropdown items={menuDe(m)} />
            </div>
          ))}
        </div>
        <div className="adm-table-wrapper solo-escritorio">
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
                      <MembresiaBadge resumen={resumenes.get(m.id)} />
                    </td>
                    <td>
                      <StatusBadge status={m.status} />
                    </td>
                    <td style={{ fontSize: '0.8125rem', color: 'var(--ek-ink-muted)' }}>
                      {new Date(m.created_at).toLocaleDateString('es-MX')}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <CardMenuDropdown items={menuDe(m)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
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
 * Estado de la MEMBRESÍA (no de la cuenta): Vigente / Vigente · gratis /
 * Pausada / Vencida (con fecha) / Sin plan. Deriva "vencida" por FECHA aunque
 * la base diga 'activa' (misma defensa que las fichas: el cron puede ir atrasado).
 */
function MembresiaBadge({ resumen }: { resumen?: ResumenMembresia }) {
  let label = 'Sin plan';
  let color = 'var(--ek-ink-muted)';
  if (resumen?.estado === 'pausada') {
    label = 'Pausada';
    color = 'var(--ek-warning)';
  } else if (resumen?.estado === 'vigente') {
    label = resumen.pagada ? 'Vigente' : 'Vigente · gratis';
    color = 'var(--ek-success)';
  } else if (resumen?.estado === 'vencida') {
    const fin = resumen.ultima.fin;
    label = fin
      ? `Vencida · ${new Date(fin).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}`
      : 'Vencida';
    color = 'var(--ek-danger)';
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
