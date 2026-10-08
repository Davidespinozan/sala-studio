import { useEffect, useMemo, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { EmptyState } from '@shared/components/EmptyState';
import { Avatar } from '@shared/components/Avatar';
import { useTenant } from '@shared/hooks/useTenant';
import { getTenantTimezone, hoyEnTimezone, fechaEnTz, formatHoraEnTz, diasEntre, sumarDias, instanteDeClase } from '@shared/lib/timezone';
import { useReservasSemana, type ReservaConJoin } from '../hooks/useReservasHoy';
import { useReceptionSucursal } from '../providers/ReceptionSucursalProvider';
import { ElegirSocioModal } from '../components/acciones/ElegirSocioModal';
import { CrearReservaModal } from '../components/acciones/CrearReservaModal';

const STATUS_CFG: Record<string, { label: string; color: string; bg: string }> = {
  confirmada: { label: 'Confirmada', color: 'var(--sala-primary)', bg: 'var(--sala-primary-light)' },
  completada: { label: 'Asistió', color: 'var(--sala-success)', bg: 'var(--sala-success-bg)' },
  no_show: { label: 'No-show', color: 'var(--sala-accent)', bg: 'var(--sala-accent-light)' },
  cancelada: { label: 'Cancelada', color: 'var(--sala-text-tertiary)', bg: 'var(--sala-bg)' },
  cancelada_admin: { label: 'Cancelada', color: 'var(--sala-text-tertiary)', bg: 'var(--sala-bg)' }
};

// Todo se agrupa y muestra en la zona del GYM: si el dueño mira desde otra zona,
// los días y horas siguen siendo los del gym (no los del navegador).
function claveDia(iso: string, tz: string): string {
  return fechaEnTz(new Date(iso), tz);
}

function etiquetaDia(diaISO: string, hoyISO: string): string {
  const difDias = diasEntre(hoyISO, diaISO);
  if (difDias === 0) return 'Hoy';
  if (difDias === 1) return 'Mañana';
  const [y, m, d] = diaISO.split('-').map(Number);
  const txt = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('es-MX', {
    weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC'
  });
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

/** Fila de expandir_clases (modelo virtual): clase_id NULL = aún virtual. */
interface ClaseExpandida {
  clase_id: string | null;
  horario_recurrente_id: string | null;
  fecha: string;
  hora_inicio: string;
  duracion_minutos: number | null;
  nombre: string;
  cupo_max: number;
  reservados: number;
  status: string;
  recurso_id: string;
  recurso_nombre: string | null;
  instructor_nombre: string | null;
  sucursal_timezone: string | null;
}

/** Una clase del día con su cupo y su lista de asistentes. Las clases salen de
 *  expandir_clases (TODAS, aunque nadie haya reservado); las reservas se pegan
 *  a su clase. Una reserva sin clase en la expansión (p. ej. horario borrado)
 *  igual aparece, como clase "suelta", para no esconder a nadie. */
interface ClaseGrupo {
  key: string;
  nombre: string;
  recursoNombre: string | null;
  instructorNombre: string | null;
  hora: string;
  slotISO: string;
  finMs: number;
  cupoMax: number | null;
  reservados: number;
  cancelada: boolean;
  /** Para reservar desde aquí (null = clase suelta sin datos de horario). */
  ref: { fecha: string; claseId: string | null; horarioId: string | null } | null;
  reservas: ReservaConJoin[];
}
interface Dia {
  key: string;
  label: string;
  clases: ClaseGrupo[];
}

const DIAS_AGENDA = 7;

export default function Agenda() {
  const tenant = useTenant();
  const tz = getTenantTimezone(tenant);
  const { sucursalId } = useReceptionSucursal();
  const { reservas, isLoading: cargandoReservas, refetch: refetchReservas } = useReservasSemana(DIAS_AGENDA);
  const [expandidas, setExpandidas] = useState<ClaseExpandida[]>([]);
  const [cargandoClases, setCargandoClases] = useState(true);
  const [recarga, setRecarga] = useState(0);
  // "+ Agregar socio": paso 1 elegir socio, paso 2 CrearReservaModal con la clase puesta.
  const [agregarA, setAgregarA] = useState<ClaseGrupo | null>(null);
  const [socioElegido, setSocioElegido] = useState<{ id: string; nombre: string } | null>(null);

  useEffect(() => {
    let cancel = false;
    setCargandoClases(true);
    (async () => {
      const hoy = hoyEnTimezone(tz);
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        name: string, args: Record<string, unknown>
      ) => Promise<{ data: ClaseExpandida[] | null; error: { message: string } | null }>;
      const { data, error } = await rpc('expandir_clases', {
        p_sucursal_id: sucursalId, p_desde: hoy, p_hasta: sumarDias(hoy, DIAS_AGENDA - 1)
      });
      if (cancel) return;
      if (error) console.error('[Agenda:expandir_clases]', error);
      setExpandidas(data ?? []);
      setCargandoClases(false);
    })();
    return () => { cancel = true; };
  }, [sucursalId, tz, recarga]);

  // Día → clase → reservas.
  const dias = useMemo<Dia[]>(() => {
    const hoyISO = hoyEnTimezone(tz);
    const map = new Map<string, Dia>();
    const diaDe = (dayKey: string) => {
      if (!map.has(dayKey)) map.set(dayKey, { key: dayKey, label: etiquetaDia(dayKey, hoyISO), clases: [] });
      return map.get(dayKey)!;
    };
    // Índices para pegar cada reserva a su clase: por clase_id (materializada) o,
    // si no, por sala + instante de inicio.
    const porClaseId = new Map<string, ClaseGrupo>();
    const porSlot = new Map<string, ClaseGrupo>();
    for (const c of expandidas) {
      const inicio = instanteDeClase(c.fecha, c.hora_inicio, c.sucursal_timezone || tz);
      const grupo: ClaseGrupo = {
        key: c.clase_id ?? `${c.horario_recurrente_id}|${c.fecha}`,
        nombre: c.nombre,
        recursoNombre: c.recurso_nombre,
        instructorNombre: c.instructor_nombre,
        hora: formatHoraEnTz(inicio, tz),
        slotISO: inicio.toISOString(),
        finMs: inicio.getTime() + (c.duracion_minutos ?? 60) * 60_000,
        cupoMax: c.cupo_max,
        reservados: c.reservados,
        cancelada: c.status === 'cancelada',
        ref: { fecha: c.fecha, claseId: c.clase_id, horarioId: c.horario_recurrente_id },
        reservas: []
      };
      diaDe(c.fecha).clases.push(grupo);
      if (c.clase_id) porClaseId.set(c.clase_id, grupo);
      porSlot.set(`${c.recurso_id}|${inicio.getTime()}`, grupo);
    }
    for (const r of reservas) {
      let grupo =
        (r.clase_id ? porClaseId.get(r.clase_id) : undefined) ??
        porSlot.get(`${r.recurso_id}|${new Date(r.slot_inicio).getTime()}`);
      if (!grupo) {
        const suelta: ClaseGrupo = {
          key: `suelta-${r.recurso_id}-${r.slot_inicio}`,
          nombre: r.recurso?.nombre ?? 'Clase',
          recursoNombre: null,
          instructorNombre: null,
          hora: formatHoraEnTz(new Date(r.slot_inicio), tz),
          slotISO: r.slot_inicio,
          finMs: new Date(r.slot_fin).getTime(),
          cupoMax: null,
          reservados: 0,
          cancelada: false,
          ref: null,
          reservas: []
        };
        diaDe(claveDia(r.slot_inicio, tz)).clases.push(suelta);
        porSlot.set(`${r.recurso_id}|${new Date(r.slot_inicio).getTime()}`, suelta);
        grupo = suelta;
      }
      grupo.reservas.push(r);
    }
    for (const dia of map.values()) dia.clases.sort((a, b) => a.slotISO.localeCompare(b.slotISO));
    return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [expandidas, reservas, tz]);

  const isLoading = cargandoReservas || cargandoClases;
  const recargar = async () => {
    setRecarga((n) => n + 1);
    await refetchReservas();
  };

  return (
    <div className="ek-page">
      <div className="rec-page-inner" style={{ maxWidth: '720px', margin: '0 auto' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '6px' }}>RECEPCIÓN</p>
        <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '28px', fontWeight: 700, letterSpacing: '-0.03em', margin: '0 0 4px', color: 'var(--sala-text-primary)' }}>
          Agenda
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', margin: '0 0 20px' }}>
          Las clases de los próximos 7 días con su cupo y sus asistentes. Agrega a un socio directo en la clase.
        </p>

        {isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="ek-skeleton" style={{ height: '64px', borderRadius: '14px' }} />
            ))}
          </div>
        ) : dias.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="Sin clases esta semana"
            subtitle="Cuando el gym tenga horarios en esta sede, aparecerán aquí."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {dias.map((dia) => (
              <section key={dia.key}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <h2 style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--sala-text-primary)', margin: 0 }}>
                    {dia.label}
                  </h2>
                  <span style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)' }}>
                    {dia.clases.length} {dia.clases.length === 1 ? 'clase' : 'clases'}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {dia.clases.map((clase) => (
                    <ClaseCard key={clase.key} clase={clase} diaLabel={dia.label} onAgregar={() => setAgregarA(clase)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {agregarA && !socioElegido && (
        <ElegirSocioModal
          titulo={`${agregarA.nombre} · ${agregarA.hora}`}
          onClose={() => setAgregarA(null)}
          onElegir={(s) => setSocioElegido({ id: s.id, nombre: s.nombre ?? s.email })}
        />
      )}
      {agregarA?.ref && socioElegido && (
        <CrearReservaModal
          socioId={socioElegido.id}
          socioNombre={socioElegido.nombre}
          claseInicial={agregarA.ref}
          isOpen
          onClose={() => { setSocioElegido(null); setAgregarA(null); }}
          onDone={recargar}
        />
      )}
    </div>
  );
}

function ClaseCard({ clase, diaLabel, onAgregar }: { clase: ClaseGrupo; diaLabel: string; onAgregar: () => void }) {
  const activos = clase.reservas.filter((r) => r.status !== 'cancelada' && r.status !== 'cancelada_admin');
  const terminada = clase.finMs < Date.now();
  // El cupo lo da expandir_clases (misma cuenta que ve el socio en la app).
  const libres = clase.cupoMax != null ? Math.max(0, clase.cupoMax - clase.reservados) : null;
  const llena = libres === 0;
  const puedeAgregar = !!clase.ref && !clase.cancelada && !terminada && !llena;

  let chip: { txt: string; color: string; bg: string };
  if (clase.cancelada) chip = { txt: 'Cancelada', color: 'var(--sala-text-tertiary)', bg: 'var(--sala-bg)' };
  else if (terminada) chip = { txt: `Terminó · ${activos.length} ${activos.length === 1 ? 'inscrito' : 'inscritos'}`, color: 'var(--sala-text-tertiary)', bg: 'var(--sala-surface)' };
  else if (libres == null) chip = { txt: `${activos.length} ${activos.length === 1 ? 'inscrito' : 'inscritos'}`, color: 'var(--sala-text-secondary)', bg: 'var(--sala-primary-light)' };
  else if (llena) chip = { txt: `Llena · ${clase.cupoMax}/${clase.cupoMax}`, color: 'var(--sala-accent)', bg: 'var(--sala-accent-light)' };
  else chip = { txt: `${libres} ${libres === 1 ? 'libre' : 'libres'} · ${clase.reservados}/${clase.cupoMax}`, color: 'var(--sala-primary)', bg: 'var(--sala-primary-light)' };

  return (
    <div style={{ borderRadius: '16px', background: 'var(--sala-surface)', border: '1px solid var(--sala-border)', overflow: 'hidden', opacity: clase.cancelada || terminada ? 0.7 : 1 }}>
      {/* Encabezado de la clase. Grid (.rec-clase-head en sala.css): en escritorio
          una sola fila; en celular hora+nombre arriba y cupo+botón abajo. */}
      <div className="rec-clase-head">
        <span style={{ fontSize: '15px', fontWeight: 800, color: 'var(--sala-text-primary)', fontVariantNumeric: 'tabular-nums' }}>
          {clase.hora}
        </span>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: 'var(--sala-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {clase.nombre}
          </p>
          {(clase.recursoNombre || clase.instructorNombre) && (
            <p style={{ margin: '1px 0 0', fontSize: '12px', color: 'var(--sala-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[clase.recursoNombre, clase.instructorNombre].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        <div className="rec-clase-acciones">
          <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: chip.color, background: chip.bg, padding: '4px 10px', borderRadius: '999px', whiteSpace: 'nowrap' }}>
            {chip.txt}
          </span>
          {puedeAgregar && (
            <button
              type="button"
              onClick={onAgregar}
              className="ek-cta ek-cta--secondary"
              style={{ fontSize: '12.5px', padding: '0 12px', minHeight: '34px', whiteSpace: 'nowrap' }}
              aria-label={`Agregar socio a ${clase.nombre} ${diaLabel} ${clase.hora}`}
            >
              + Agregar
            </button>
          )}
        </div>
      </div>
      {/* Lista de asistentes */}
      {clase.reservas.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {clase.reservas.map((r) => (
            <FilaAsistente key={r.id} r={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilaAsistente({ r }: { r: ReservaConJoin }) {
  const cfg = STATUS_CFG[r.status] ?? { label: r.status, color: 'var(--sala-text-tertiary)', bg: 'var(--sala-bg)' };
  const nombre = r.usuario?.nombre ?? r.usuario?.email ?? 'Socio';
  const invitados = (r as { invitados_count?: number }).invitados_count ?? 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', borderTop: '1px solid var(--sala-border)' }}>
      <Avatar src={r.usuario?.avatar_url} nombre={nombre} email={r.usuario?.email} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--sala-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {nombre}{invitados > 0 ? ` +${invitados}` : ''}
        </p>
      </div>
      <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: cfg.color, background: cfg.bg, padding: '4px 10px', borderRadius: '999px', whiteSpace: 'nowrap' }}>
        {cfg.label}
      </span>
    </div>
  );
}