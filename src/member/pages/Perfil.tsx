import { useEffect, useState } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { supabase } from '@shared/lib/supabase';
import type { Database } from '@shared/types/database';

type Reserva = Database['public']['Tables']['reservas']['Row'];
type Recurso = Database['public']['Tables']['recursos']['Row'];

interface ReservaConRecurso extends Reserva {
  recurso: Pick<Recurso, 'nombre'> | null;
}

function useStatsDelMes(usuarioId: string | undefined) {
  const [sesionesEsteMes, setSesionesEsteMes] = useState(0);

  useEffect(() => {
    if (!usuarioId) return;
    let mounted = true;
    async function load() {
      const inicio = new Date();
      inicio.setDate(1);
      inicio.setHours(0, 0, 0, 0);

      const { count } = await supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('usuario_id', usuarioId!)
        .eq('status', 'completada')
        .gte('check_in_at', inicio.toISOString());

      if (mounted) setSesionesEsteMes(count ?? 0);
    }
    load();
    return () => { mounted = false; };
  }, [usuarioId]);

  return { sesionesEsteMes };
}

function useReservasPasadas(usuarioId: string | undefined) {
  const [reservas, setReservas] = useState<ReservaConRecurso[]>([]);

  useEffect(() => {
    if (!usuarioId) return;
    let mounted = true;
    async function load() {
      const { data } = await supabase
        .from('reservas')
        .select('*, recurso:recursos(nombre)')
        .eq('usuario_id', usuarioId!)
        .in('status', ['completada', 'cancelada', 'no_show'])
        .order('slot_inicio', { ascending: false })
        .limit(20);
      if (mounted) setReservas((data ?? []) as unknown as ReservaConRecurso[]);
    }
    load();
    return () => { mounted = false; };
  }, [usuarioId]);

  return { reservas };
}

function formatearFecha(iso: string): string {
  const d = new Date(iso);
  const fecha = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  const hora = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fecha} · ${hora}`;
}

export default function Perfil() {
  const { authUser, usuario, signOut } = useAuth();
  const tenant = useTenant();
  const { reservas } = useReservasPasadas(usuario?.id);
  const { sesionesEsteMes } = useStatsDelMes(usuario?.id);

  const nombreFormat = usuario?.nombre
    ?.toLowerCase()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') ?? '';

  const initials = (usuario?.nombre ?? usuario?.email ?? '?')
    .split(/[\s@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <div className="ek-stack-md">
          <p className="ek-eyebrow">PERFIL</p>
          <h1 className="ek-display-md">{nombreFormat || 'Tu cuenta'}</h1>
        </div>

        {/* Avatar */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          {usuario?.avatar_url ? (
            <img
              src={usuario.avatar_url}
              alt={usuario.nombre ?? 'Avatar'}
              style={{
                width: '120px',
                height: '120px',
                borderRadius: '50%',
                objectFit: 'cover',
                border: '0.5px solid var(--ek-line)'
              }}
            />
          ) : (
            <div style={{
              width: '120px',
              height: '120px',
              borderRadius: '50%',
              background: 'var(--ek-mustard)',
              color: 'var(--ek-bg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--ek-font-display)',
              fontSize: '40px',
              fontWeight: 700,
              letterSpacing: '-0.04em'
            }}>
              {initials}
            </div>
          )}
        </div>

        <div className="adm-info-grid">
          <div className="adm-info-cell">
            <p className="adm-info-label">Email</p>
            <p className="adm-info-value">{authUser?.email}</p>
          </div>
          {usuario?.telefono && (
            <div className="adm-info-cell">
              <p className="adm-info-label">Teléfono</p>
              <p className="adm-info-value">{usuario.telefono}</p>
            </div>
          )}
          <div className="adm-info-cell">
            <p className="adm-info-label">Tenant</p>
            <p className="adm-info-value">{tenant.nombre}</p>
          </div>
          <div className="adm-info-cell">
            <p className="adm-info-label">Rol</p>
            <p className="adm-info-value adm-info-value--mono">{usuario?.rol}</p>
          </div>
          <div className="adm-info-cell">
            <p className="adm-info-label">Status</p>
            <p className="adm-info-value adm-info-value--mono">{usuario?.status}</p>
          </div>
          {usuario?.membresia_tier && (
            <div className="adm-info-cell">
              <p className="adm-info-label">Plan</p>
              <p className="adm-info-value adm-info-value--mono">{usuario.membresia_tier}</p>
            </div>
          )}
        </div>

        <button onClick={signOut} className="ek-cta ek-cta--secondary ek-cta--full">
          Cerrar sesión
        </button>

        {/* Stat del mes */}
        <section style={{ marginTop: '32px', marginBottom: '24px' }}>
          <div className="ek-stat-card" style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <div>
              <p className="ek-eyebrow" style={{ marginBottom: '6px' }}>ESTE MES</p>
              <p className="ek-kpi">
                {sesionesEsteMes}{' '}
                <span style={{
                  fontSize: '15px',
                  fontWeight: 500,
                  color: 'var(--ek-ink-muted)',
                  letterSpacing: 'normal'
                }}>
                  {sesionesEsteMes === 1 ? 'sesión completada' : 'sesiones completadas'}
                </span>
              </p>
            </div>
          </div>
        </section>

        {/* Reservas pasadas */}
        <section>
          <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>HISTORIAL</p>
          <h2 className="ek-display-md" style={{ marginBottom: '16px' }}>Reservas pasadas</h2>

          {reservas.length === 0 ? (
            <p className="ek-body-muted">Aún no tienes sesiones completadas.</p>
          ) : (
            <div className="ek-stack-sm">
              {reservas.map((r) => (
                <div key={r.id} className="ek-card ek-card--md" style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{
                      fontFamily: 'var(--ek-font-display)',
                      fontSize: '14px',
                      fontWeight: 600,
                      letterSpacing: '-0.02em',
                      margin: 0
                    }}>
                      {r.recurso?.nombre ?? 'Estudio'}
                    </p>
                    <p className="ek-body-faint" style={{ marginTop: '2px' }}>
                      {formatearFecha(r.slot_inicio)}
                    </p>
                  </div>
                  <span className={
                    r.status === 'completada' ? 'ek-badge ek-badge--success' :
                    r.status === 'cancelada' ? 'ek-badge ek-badge--neutral' :
                    'ek-badge ek-badge--danger'
                  }>
                    {r.status === 'completada' ? 'OK' :
                     r.status === 'cancelada' ? 'CANCELADA' :
                     'NO SHOW'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
