import { useEffect, useMemo, useState } from 'react';
import { useTenant } from '@shared/hooks/useTenant';
import { useSucursal } from '../providers/SucursalProvider';
import { getSucursalTimezone, getTenantTimezone, hoyEnTimezone } from '@shared/lib/timezone';
import { useRecursosAdmin } from '../hooks/useAdminData';
import { useClasesSemanaAdmin } from '../hooks/useClasesSemanaAdmin';
import { AgendaSemanal } from '../components/agenda/AgendaSemanal';
import { AgendaListaDia } from '../components/agenda/AgendaListaDia';
import { ListaInscritosModal } from '../components/agenda/ListaInscritosModal';
import { CrearClaseManualModal } from '../components/agenda/CrearClaseManualModal';
import { formatDateISO } from '@member/logic/reservaLogic';
import type { Clase } from '@member/logic/claseAdapter';

const SALA_TODAS = '__todas__';

/** Lunes 00:00 de la semana que contiene `d`. */
function inicioSemanaDe(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay(); // 0=dom, 1=lun, ...
  const diff = day === 0 ? -6 : 1 - day; // dom → -6 lunes; otros → diff a lunes
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** Date a medianoche local de una fecha 'YYYY-MM-DD'. */
function fechaLocal(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export default function Agenda() {
  const tenant = useTenant();
  const { sucursalId, sucursalActiva } = useSucursal();
  const tz = getSucursalTimezone(sucursalActiva?.timezone, getTenantTimezone(tenant));
  // S4.4: "hoy" es el de la timezone del gym, no la del browser del admin.
  const hoyISO = hoyEnTimezone(tz);

  const { recursos, isLoading: loadingRecursos } = useRecursosAdmin();
  const [inicioSemana, setInicioSemana] = useState<Date>(() =>
    inicioSemanaDe(fechaLocal(hoyISO))
  );
  const [salaSel, setSalaSel] = useState<string>(SALA_TODAS);
  const [fechaSel, setFechaSel] = useState<string>(hoyISO);
  const [refreshTick, setRefreshTick] = useState(0);

  // Al cambiar de sucursal, el filtro de sala apunta a una sala de otra
  // sucursal: reseteamos a "todas" para no mostrar una grilla vacía.
  useEffect(() => {
    setSalaSel(SALA_TODAS);
  }, [sucursalId]);

  const { clases, isLoading: loadingClases, refetch } = useClasesSemanaAdmin(
    inicioSemana,
    salaSel === SALA_TODAS ? undefined : salaSel
  );

  // Refresh externo (cuando un modal hace cambios)
  useMemo(() => {
    if (refreshTick > 0) void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const [claseSel, setClaseSel] = useState<Clase | null>(null);
  const [slotVacioSel, setSlotVacioSel] = useState<{ fecha: Date; hora: number } | null>(null);
  const [crearClaseOpen, setCrearClaseOpen] = useState(false);

  const recursosActivos = recursos.filter((r) => r.activo);

  // Fechas para DayTabSelector mobile: 7 días de la semana actual
  const fechas = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(inicioSemana);
        d.setDate(inicioSemana.getDate() + i);
        return { fechaISO: formatDateISO(d), date: d };
      }),
    [inicioSemana]
  );

  // Si el día seleccionado cae fuera de la semana visible (al cambiar de semana),
  // re-snap al primer día de la nueva semana.
  useMemo(() => {
    const inRange = fechas.some((f) => f.fechaISO === fechaSel);
    if (!inRange) setFechaSel(fechas[0].fechaISO);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inicioSemana]);

  function navSemana(delta: number) {
    const d = new Date(inicioSemana);
    d.setDate(inicioSemana.getDate() + delta * 7);
    setInicioSemana(d);
  }

  const finSemana = useMemo(() => {
    const d = new Date(inicioSemana);
    d.setDate(inicioSemana.getDate() + 6);
    return d;
  }, [inicioSemana]);

  const labelSemana = `${inicioSemana.toLocaleDateString('es-MX', {
    day: 'numeric',
    month: 'short'
  })} – ${finSemana.toLocaleDateString('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })}`;

  if (loadingRecursos) {
    return (
      <div className="adm-page">
        <p className="adm-body">Cargando agenda…</p>
      </div>
    );
  }

  return (
    <div className="adm-page">
      <div className="adm-hero">
        <p className="adm-hero-eyebrow">Agenda semanal</p>
        <h1 className="adm-hero-title">Tus clases de la semana</h1>
        <p className="adm-hero-subtitle">
          Todas las salas, en una sola vista. Click en una clase para gestionar inscritos.
        </p>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
        <button
          type="button"
          onClick={() => setCrearClaseOpen(true)}
          disabled={recursosActivos.length === 0}
          className="ek-cta"
          style={{ padding: '10px 18px', fontSize: '13px' }}
        >
          + Nueva clase
        </button>
      </div>

      {/* Controles: semana + sala filter */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          marginBottom: '20px'
        }}
      >
        {/* Nav semana */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'var(--sala-surface)',
            border: '1px solid var(--sala-border)',
            borderRadius: '12px',
            padding: '8px 12px',
            gap: '12px'
          }}
        >
          <button
            type="button"
            onClick={() => navSemana(-1)}
            className="ek-icon-btn"
            style={{ width: 'auto', padding: '8px 14px', fontSize: '13px' }}
          >
            ← Anterior
          </button>
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '15px',
              fontWeight: 600,
              color: 'var(--sala-text-primary)',
              margin: 0,
              fontVariantNumeric: 'tabular-nums',
              textAlign: 'center',
              flex: 1
            }}
          >
            {labelSemana}
          </p>
          <button
            type="button"
            onClick={() => navSemana(1)}
            className="ek-icon-btn"
            style={{ width: 'auto', padding: '8px 14px', fontSize: '13px' }}
          >
            Siguiente →
          </button>
        </div>

        {/* Filtro de sala */}
        <div
          style={{
            display: 'flex',
            gap: '8px',
            overflowX: 'auto',
            paddingBottom: '4px',
            scrollbarWidth: 'none'
          }}
        >
          <SalaChip
            label="Todas las salas"
            active={salaSel === SALA_TODAS}
            onClick={() => setSalaSel(SALA_TODAS)}
          />
          {recursosActivos.map((r) => (
            <SalaChip
              key={r.id}
              label={r.nombre}
              active={salaSel === r.id}
              onClick={() => setSalaSel(r.id)}
            />
          ))}
          <button
            type="button"
            onClick={() => {
              setInicioSemana(inicioSemanaDe(fechaLocal(hoyISO)));
              setFechaSel(hoyISO);
            }}
            style={{
              flexShrink: 0,
              marginLeft: 'auto',
              padding: '8px 14px',
              minHeight: '36px',
              background: 'transparent',
              color: 'var(--sala-primary)',
              border: '1px solid var(--sala-primary)',
              borderRadius: '999px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap'
            }}
          >
            Hoy
          </button>
        </div>
      </div>

      {/* Loading state */}
      {loadingClases && (
        <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', margin: '12px 0' }}>
          Cargando clases de la semana…
        </p>
      )}

      {/* Empty state */}
      {!loadingClases && clases.length === 0 && (
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
            Semana sin clases
          </p>
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '18px',
              fontWeight: 600,
              color: 'var(--sala-text-primary)',
              margin: 0,
              marginBottom: '4px'
            }}
          >
            No hay clases programadas en esta semana.
          </p>
          <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: 0 }}>
            Verificá los horarios de tus salas en <strong>Salas → Editar</strong>.
          </p>
        </div>
      )}

      {/* Vista desktop / mobile (toggle CSS) */}
      {!loadingClases && clases.length > 0 && (
        <>
          <div className="adm-agenda-desktop">
            <AgendaSemanal
              clases={clases}
              inicioSemana={inicioSemana}
              hoyISO={hoyISO}
              onClickClase={setClaseSel}
              onClickSlotVacio={(fecha, hora) => setSlotVacioSel({ fecha, hora })}
            />
          </div>
          <div className="adm-agenda-mobile">
            <AgendaListaDia
              clases={clases}
              fechaSel={fechaSel}
              fechas={fechas}
              onFechaSelChange={setFechaSel}
              onClickClase={setClaseSel}
            />
          </div>
        </>
      )}

      {/* Modales */}
      {claseSel && (
        <ListaInscritosModal
          clase={claseSel}
          onClose={() => {
            setClaseSel(null);
            setRefreshTick((t) => t + 1);
          }}
        />
      )}

      {(slotVacioSel || crearClaseOpen) && (
        <CrearClaseManualModal
          recursos={recursosActivos}
          prefill={slotVacioSel}
          onClose={() => {
            setSlotVacioSel(null);
            setCrearClaseOpen(false);
          }}
          onCreated={() => setRefreshTick((t) => t + 1)}
        />
      )}
    </div>
  );
}

function SalaChip({
  label,
  active,
  onClick
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flexShrink: 0,
        padding: '8px 16px',
        minHeight: '36px',
        background: active ? 'var(--sala-primary)' : 'var(--sala-surface)',
        color: active ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)',
        border: `1px solid ${active ? 'var(--sala-primary)' : 'var(--sala-border)'}`,
        borderRadius: '999px',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        transition: 'background 0.18s ease, border-color 0.18s ease, color 0.18s ease'
      }}
    >
      {label}
    </button>
  );
}
