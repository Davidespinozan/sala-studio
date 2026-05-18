import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import CardMenuDropdown from './CardMenuDropdown';
import type { Database } from '@shared/types/database';

type Recurso = Pick<Database['public']['Tables']['recursos']['Row'], 'id' | 'nombre'>;

export interface ReservaListada {
  id: string;
  slot_inicio: string;
  slot_fin: string;
  status: string;
  folio: string;
  recurso_id: string;
  recurso_nombre: string;
  usuario_nombre: string;
  usuario_email: string;
  tier: string | null;
}

const PAGE_SIZE = 25;

const ESTADOS_LABEL: Record<string, { texto: string; color: string }> = {
  confirmada: { texto: 'Confirmada', color: 'var(--ek-success)' },
  completada: { texto: 'Completada', color: 'var(--ek-success)' },
  cancelada: { texto: 'Cancelada', color: 'var(--ek-danger)' },
  cancelada_admin: { texto: 'Cancelada admin', color: 'var(--ek-danger)' },
  no_show: { texto: 'No-show', color: 'var(--ek-mustard)' }
};

function capitalizar(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseInputDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

interface Props {
  refreshTick: number;
  onVerDetalle: (reservaId: string) => void;
  onCancelar: (info: {
    id: string;
    slot_inicio: string;
    recurso_nombre: string;
    usuario_nombre: string;
    tier: string | null;
  }) => void;
}

export default function ReservasVistaLista({ refreshTick, onVerDetalle, onCancelar }: Props) {
  const tenant = useTenant();
  const toast = useToast();

  const hoy = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const [desde, setDesde] = useState<string>(() => isoDate(hoy));
  const [hasta, setHasta] = useState<string>(() => {
    const d = new Date(hoy);
    d.setDate(d.getDate() + 14);
    return isoDate(d);
  });
  const [recursoId, setRecursoId] = useState<string>('todos');
  const [estado, setEstado] = useState<string>('todos');
  const [busqueda, setBusqueda] = useState<string>('');
  const [busquedaDebounced, setBusquedaDebounced] = useState<string>('');
  const [pagina, setPagina] = useState<number>(1);

  const [recursos, setRecursos] = useState<Recurso[]>([]);
  const [reservas, setReservas] = useState<ReservaListada[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Debounce búsqueda
  useEffect(() => {
    const t = setTimeout(() => setBusquedaDebounced(busqueda.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [busqueda]);

  // Reset paginación al cambiar filtros
  useEffect(() => {
    setPagina(1);
  }, [desde, hasta, recursoId, estado, busquedaDebounced]);

  // Cargar recursos para el select
  useEffect(() => {
    supabase
      .from('recursos')
      .select('id, nombre')
      .eq('tenant_id', tenant.id)
      .order('nombre', { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          console.error('[ReservasVistaLista:recursos]', error);
          return;
        }
        setRecursos(data ?? []);
      });
  }, [tenant.id]);

  const rangoInvalido = parseInputDate(desde).getTime() > parseInputDate(hasta).getTime();

  const cargarReservas = useCallback(async () => {
    if (rangoInvalido) {
      setReservas([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);

    const desdeDate = parseInputDate(desde);
    desdeDate.setHours(0, 0, 0, 0);
    const hastaDate = parseInputDate(hasta);
    hastaDate.setHours(23, 59, 59, 999);

    let query = supabase
      .from('reservas')
      .select(
        'id, slot_inicio, slot_fin, status, folio, recurso_id, recurso:recursos(nombre), usuario:usuarios!reservas_usuario_id_fkey(nombre, email, membresia_tier)'
      )
      .eq('tenant_id', tenant.id)
      .gte('slot_inicio', desdeDate.toISOString())
      .lte('slot_inicio', hastaDate.toISOString())
      .order('slot_inicio', { ascending: true })
      .limit(500);

    if (recursoId !== 'todos') query = query.eq('recurso_id', recursoId);
    if (estado !== 'todos') query = query.eq('status', estado);

    const { data, error } = await query;
    if (error) {
      console.error('[ReservasVistaLista]', error);
      toast.error('No se pudieron cargar las reservas.');
      setIsLoading(false);
      return;
    }

    let lista: ReservaListada[] = (data ?? []).map((row) => {
      const r = row as unknown as {
        id: string;
        slot_inicio: string;
        slot_fin: string;
        status: string;
        folio: string;
        recurso_id: string;
        recurso?: { nombre?: string } | null;
        usuario?: { nombre?: string | null; email?: string; membresia_tier?: string | null } | null;
      };
      return {
        id: r.id,
        slot_inicio: r.slot_inicio,
        slot_fin: r.slot_fin,
        status: r.status,
        folio: r.folio,
        recurso_id: r.recurso_id,
        recurso_nombre: r.recurso?.nombre ?? '—',
        usuario_nombre: capitalizar(r.usuario?.nombre) || r.usuario?.email || '—',
        usuario_email: r.usuario?.email ?? '—',
        tier: r.usuario?.membresia_tier ?? null
      };
    });

    if (busquedaDebounced) {
      lista = lista.filter(
        (r) =>
          r.usuario_nombre.toLowerCase().includes(busquedaDebounced) ||
          r.usuario_email.toLowerCase().includes(busquedaDebounced)
      );
    }

    setReservas(lista);
    setIsLoading(false);
  }, [tenant.id, desde, hasta, recursoId, estado, busquedaDebounced, rangoInvalido, toast]);

  useEffect(() => {
    void cargarReservas();
  }, [cargarReservas, refreshTick]);

  function limpiarFiltros() {
    setDesde(isoDate(hoy));
    const d = new Date(hoy);
    d.setDate(d.getDate() + 14);
    setHasta(isoDate(d));
    setRecursoId('todos');
    setEstado('todos');
    setBusqueda('');
  }

  const totalPaginas = Math.max(1, Math.ceil(reservas.length / PAGE_SIZE));
  const paginaActual = Math.min(pagina, totalPaginas);
  const pageStart = (paginaActual - 1) * PAGE_SIZE;
  const reservasPagina = reservas.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <>
      <div
        className="ek-card"
        style={{ padding: '20px', marginBottom: '20px', display: 'block' }}
      >
        <p
          className="ek-eyebrow ek-eyebrow--mustard"
          style={{ fontSize: '11px', marginBottom: '14px' }}
        >
          FILTROS
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: '10px',
            marginBottom: '12px'
          }}
        >
          <div className="ek-form-field">
            <label className="ek-label">Desde</label>
            <input
              type="date"
              value={desde}
              onChange={(e) => setDesde(e.target.value)}
              className="ek-input"
            />
          </div>
          <div className="ek-form-field">
            <label className="ek-label">Hasta</label>
            <input
              type="date"
              value={hasta}
              onChange={(e) => setHasta(e.target.value)}
              className="ek-input"
            />
          </div>
          <div className="ek-form-field">
            <label className="ek-label">Estudio</label>
            <select
              value={recursoId}
              onChange={(e) => setRecursoId(e.target.value)}
              className="ek-input"
            >
              <option value="todos">Todos</option>
              {recursos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.nombre}
                </option>
              ))}
            </select>
          </div>
          <div className="ek-form-field">
            <label className="ek-label">Estado</label>
            <select
              value={estado}
              onChange={(e) => setEstado(e.target.value)}
              className="ek-input"
            >
              <option value="todos">Todos</option>
              <option value="confirmada">Confirmada</option>
              <option value="cancelada_admin">Cancelada admin</option>
              <option value="cancelada">Cancelada miembro</option>
              <option value="no_show">No-show</option>
              <option value="completada">Completada</option>
            </select>
          </div>
        </div>
        <div className="ek-form-field" style={{ marginBottom: 0 }}>
          <label className="ek-label">Buscar miembro</label>
          <input
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Nombre o email…"
            className="ek-input"
          />
        </div>

        {rangoInvalido && (
          <p style={{ fontSize: '12px', color: 'var(--ek-danger)', marginTop: '10px' }}>
            Rango inválido: la fecha &quot;desde&quot; debe ser anterior o igual a &quot;hasta&quot;.
          </p>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: '14px'
          }}
        >
          <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>
            {isLoading
              ? 'Cargando…'
              : `${reservas.length} ${reservas.length === 1 ? 'reserva encontrada' : 'reservas encontradas'}`}
          </p>
          <button
            type="button"
            onClick={limpiarFiltros}
            className="ek-icon-btn"
            style={{ width: 'auto', padding: '6px 14px', fontSize: '12px' }}
          >
            Limpiar filtros
          </button>
        </div>
      </div>

      {!isLoading && reservas.length === 0 ? (
        <div className="ek-card" style={{ padding: '40px 20px', textAlign: 'center' }}>
          <p className="ek-body-faint" style={{ margin: 0, marginBottom: '12px' }}>
            No hay reservas que coincidan con los filtros.
          </p>
          <button
            type="button"
            onClick={limpiarFiltros}
            className="ek-cta ek-cta--secondary"
            style={{ padding: '10px 20px', fontSize: '13px' }}
          >
            Limpiar filtros
          </button>
        </div>
      ) : (
        <>
          <div
            style={{
              background: 'var(--ek-bg-soft)',
              border: '0.5px solid var(--ek-line)',
              borderRadius: 'var(--ek-r-md)',
              overflow: 'hidden'
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '120px 90px 1.2fr 1.5fr 90px 130px 40px',
                gap: '12px',
                padding: '12px 16px',
                background: 'var(--ek-bg-elevated)',
                borderBottom: '0.5px solid var(--ek-line)',
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.12em',
                color: 'var(--ek-ink-faint)',
                textTransform: 'uppercase'
              }}
            >
              <span>Fecha</span>
              <span>Hora</span>
              <span>Estudio</span>
              <span>Miembro</span>
              <span>Plan</span>
              <span>Estado</span>
              <span />
            </div>
            {reservasPagina.map((r) => (
              <ReservaRow
                key={r.id}
                reserva={r}
                onVerDetalle={() => onVerDetalle(r.id)}
                onCancelar={() =>
                  onCancelar({
                    id: r.id,
                    slot_inicio: r.slot_inicio,
                    recurso_nombre: r.recurso_nombre,
                    usuario_nombre: r.usuario_nombre,
                    tier: r.tier
                  })
                }
              />
            ))}
          </div>

          {totalPaginas > 1 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: '14px',
                gap: '12px'
              }}
            >
              <button
                type="button"
                onClick={() => setPagina((p) => Math.max(1, p - 1))}
                disabled={paginaActual === 1}
                className="ek-icon-btn"
                style={{ width: 'auto', padding: '8px 14px', fontSize: '12px' }}
              >
                ← Anterior
              </button>
              <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0 }}>
                Página {paginaActual} de {totalPaginas}
              </p>
              <button
                type="button"
                onClick={() => setPagina((p) => Math.min(totalPaginas, p + 1))}
                disabled={paginaActual === totalPaginas}
                className="ek-icon-btn"
                style={{ width: 'auto', padding: '8px 14px', fontSize: '12px' }}
              >
                Siguiente →
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function ReservaRow({
  reserva,
  onVerDetalle,
  onCancelar
}: {
  reserva: ReservaListada;
  onVerDetalle: () => void;
  onCancelar: () => void;
}) {
  const fecha = new Date(reserva.slot_inicio);
  const esFutura = fecha.getTime() > Date.now();
  const esConfirmada = reserva.status === 'confirmada';
  const puedeCancelar = esFutura && esConfirmada;
  const estado = ESTADOS_LABEL[reserva.status] ?? {
    texto: reserva.status,
    color: 'var(--ek-ink-muted)'
  };

  return (
    <div
      onClick={onVerDetalle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onVerDetalle();
        }
      }}
      style={{
        display: 'grid',
        gridTemplateColumns: '120px 90px 1.2fr 1.5fr 90px 130px 40px',
        gap: '12px',
        padding: '12px 16px',
        borderBottom: '0.5px solid var(--ek-line)',
        cursor: 'pointer',
        alignItems: 'center',
        fontSize: '13px',
        transition: 'background 0.15s ease'
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--ek-mustard-soft)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ color: 'var(--ek-ink-muted)' }}>
        {fecha.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' })}
      </span>
      <span style={{ color: 'var(--ek-ink)', fontWeight: 600 }}>
        {fecha.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true })}
      </span>
      <span
        style={{
          color: 'var(--ek-ink)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {reserva.recurso_nombre}
      </span>
      <span
        style={{
          color: 'var(--ek-ink)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {reserva.usuario_nombre}
      </span>
      <span style={{ color: 'var(--ek-ink-muted)', fontSize: '12px' }}>
        {reserva.tier ?? '—'}
      </span>
      <span style={{ color: estado.color, fontWeight: 600, fontSize: '12px' }}>
        {estado.texto}
      </span>
      <CardMenuDropdown
        items={[
          { label: 'Ver detalle', icon: '👁', onClick: onVerDetalle },
          ...(puedeCancelar
            ? [
                {
                  label: 'Cancelar reserva',
                  icon: '🚫',
                  onClick: onCancelar,
                  danger: true,
                  divider: true
                }
              ]
            : [])
        ]}
      />
    </div>
  );
}
