import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import {
  useRecursosDelTenant,
  fetchReservasDelRecurso,
  fetchReservasDelUsuario,
  crearReserva
} from '../hooks/useReservas';
import {
  generarSlotsDisponibles,
  generarFechasReservables,
  formatHora,
  type TenantReservaConfig,
  type Slot
} from '../logic/reservaLogic';
import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];

function tierTieneAcceso(recurso: Recurso, tier: string | null | undefined): boolean {
  return tier ? recurso.tiers_permitidos.includes(tier) : false;
}

export default function Reservar() {
  const tenant = useTenant();
  const { usuario } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const recursoSlugParam = searchParams.get('recurso');
  const { recursos, isLoading: loadingRecursos } = useRecursosDelTenant();

  const config = useMemo<TenantReservaConfig>(() => {
    const c = (tenant.config as Record<string, any>)?.reserva ?? {};
    return {
      duracion_default_min: c.duracion_default_min ?? 60,
      cupos_por_recurso: c.cupos_por_recurso ?? 1,
      permitir_continuas: c.permitir_continuas ?? false,
      anticipacion_min_horas: c.anticipacion_min_horas ?? 24,
      anticipacion_max_dias: c.anticipacion_max_dias ?? 30,
      ventana_check_in_min: c.ventana_check_in_min ?? 15
    };
  }, [tenant.config]);

  const tier = usuario?.membresia_tier ?? null;
  const puedeUsar = (r: Recurso) => tierTieneAcceso(r, tier);

  const fechas = useMemo(() => generarFechasReservables(config), [config]);

  const [recursoSel, setRecursoSel] = useState<Recurso | null>(null);
  const [fechaSel, setFechaSel] = useState<string>(fechas[0]?.fechaISO ?? '');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotPendiente, setSlotPendiente] = useState<Slot | null>(null);
  const [invitados, setInvitados] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxInvitados = usuario?.membresia_tier === 'pro' ? 4 :
                       usuario?.membresia_tier === 'basica' ? 2 : 0;

  // Resetear invitados cuando se abre/cierra el modal
  useEffect(() => {
    if (!slotPendiente) setInvitados(0);
  }, [slotPendiente]);

  // Auto-seleccionar primer recurso accesible (o el del query param ?recurso=slug)
  useEffect(() => {
    if (recursoSel || recursos.length === 0) return;

    if (recursoSlugParam) {
      const found = recursos.find((r) => r.slug === recursoSlugParam);
      if (found && tierTieneAcceso(found, tier)) {
        setRecursoSel(found);
        return;
      }
    }

    const primerAccesible = recursos.find((r) => tierTieneAcceso(r, tier));
    if (primerAccesible) setRecursoSel(primerAccesible);
  }, [recursos, recursoSel, recursoSlugParam, tier]);

  // Recargar slots cuando cambia recurso o fecha
  useEffect(() => {
    if (!recursoSel || !fechaSel || !usuario) return;

    let mounted = true;
    setLoadingSlots(true);

    const fechaInicio = new Date(fechaSel + 'T00:00:00');
    const fechaFin = new Date(fechaSel + 'T23:59:59');

    Promise.all([
      fetchReservasDelRecurso(recursoSel.id, fechaInicio, fechaFin),
      fetchReservasDelUsuario(usuario.id, fechaInicio, fechaFin)
    ]).then(([reservasRecurso, reservasUsuario]) => {
      if (!mounted) return;
      const generados = generarSlotsDisponibles(
        recursoSel,
        fechaSel,
        config,
        reservasRecurso,
        reservasUsuario
      );
      setSlots(generados);
      setLoadingSlots(false);
    });

    return () => { mounted = false; };
  }, [recursoSel, fechaSel, usuario, config]);

  async function confirmarReserva() {
    if (!slotPendiente || !recursoSel) return;
    setSubmitting(true);
    setError(null);
    try {
      await crearReserva({
        recursoId: recursoSel.id,
        slotInicio: slotPendiente.inicio,
        duracionMin: config.duracion_default_min,
        invitados,
        notas: undefined
      });
      setSlotPendiente(null);
      setSubmitting(false);
      navigate('/app/historial');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error reservando');
      setSubmitting(false);
    }
  }

  if (loadingRecursos) {
    return <div className="ek-container"><p className="ek-body">Cargando estudios…</p></div>;
  }

  if (recursos.length === 0) {
    return (
      <div className="ek-container">
        <div className="ek-stack-lg">
          <p className="ek-eyebrow">SIN ESTUDIOS DISPONIBLES</p>
          <p className="ek-body">
            No hay estudios activos en este momento. Contacta al administrador.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <div className="ek-stack-md">
          <p className="ek-eyebrow">RESERVAR</p>
          <h1 className="ek-h2">Elige tu sesión</h1>
        </div>

        {/* Selector de recurso */}
        <div className="ek-stack-sm">
          <label className="ek-label">Estudio</label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {recursos.map((r) => {
              const activo = recursoSel?.id === r.id;
              const accesible = puedeUsar(r);
              const esPro = r.tiers_permitidos.length === 1 && r.tiers_permitidos[0] === 'pro';
              return (
                <button
                  key={r.id}
                  onClick={() => {
                    if (!accesible) {
                      toast.warning('Tu plan no incluye este estudio. Ve a Estudios para más info.');
                      return;
                    }
                    setRecursoSel(r);
                  }}
                  style={{
                    padding: '10px 18px',
                    minHeight: '44px',
                    background: activo && accesible ? 'var(--ek-mustard-soft)' : 'transparent',
                    color: activo && accesible
                      ? 'var(--ek-mustard)'
                      : accesible ? 'var(--ek-ink-muted)' : 'var(--ek-ink-faint)',
                    border: `0.5px solid ${activo && accesible ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
                    borderRadius: 'var(--ek-r-pill)',
                    fontWeight: 600,
                    fontSize: '14px',
                    cursor: accesible ? 'pointer' : 'not-allowed',
                    opacity: accesible ? 1 : 0.5,
                    fontFamily: 'var(--ek-font-body)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}
                >
                  {r.nombre}
                  {esPro && !accesible && (
                    <span style={{
                      fontSize: '9px',
                      color: 'var(--ek-mustard)',
                      fontWeight: 700,
                      letterSpacing: '0.12em'
                    }}>★ PRO</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Selector de fecha */}
        <div className="ek-stack-sm">
          <label className="ek-label">Fecha</label>
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              overflowX: 'auto',
              paddingBottom: '0.5rem',
              scrollbarWidth: 'thin'
            }}
          >
            {fechas.slice(0, 14).map((f) => {
              const activo = fechaSel === f.fechaISO;
              return (
                <button
                  key={f.fechaISO}
                  onClick={() => setFechaSel(f.fechaISO)}
                  style={{
                    flexShrink: 0,
                    padding: '10px 14px',
                    minHeight: '44px',
                    background: activo ? 'var(--ek-mustard-soft)' : 'var(--ek-bg-soft)',
                    color: activo ? 'var(--ek-mustard)' : 'var(--ek-ink)',
                    border: `0.5px solid ${activo ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
                    borderRadius: 'var(--ek-r-sm)',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    fontFamily: 'var(--ek-font-body)'
                  }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Grid de slots */}
        <div className="ek-stack-sm">
          <label className="ek-label">Horario</label>
          {loadingSlots ? (
            <p className="ek-body-muted">Cargando horarios…</p>
          ) : slots.length === 0 ? (
            <p className="ek-body-muted">
              El estudio no opera este día.
            </p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))', gap: '8px' }}>
              {slots.map((slot, i) => {
                const tooltip = slot.disponible
                  ? undefined
                  : slot.razon === 'pasado' ? 'Ya pasó'
                  : slot.razon === 'ocupado' ? 'Ya reservado'
                  : slot.razon === 'continuo' ? 'No puedes reservar continuas'
                  : slot.razon === 'anticipacion_insuficiente' ? 'Anticipación insuficiente'
                  : 'No disponible';

                return (
                  <button
                    key={i}
                    disabled={!slot.disponible}
                    onClick={() => setSlotPendiente(slot)}
                    title={tooltip}
                    style={{
                      padding: '14px 8px',
                      minHeight: '52px',
                      background: slot.disponible ? 'var(--ek-bg-soft)' : 'transparent',
                      color: slot.disponible ? 'var(--ek-ink)' : 'var(--ek-ink-faint)',
                      border: '0.5px solid var(--ek-line)',
                      borderRadius: 'var(--ek-r-sm)',
                      fontFamily: 'var(--ek-font-mono)',
                      fontSize: '15px',
                      fontWeight: 600,
                      cursor: slot.disponible ? 'pointer' : 'not-allowed',
                      opacity: slot.disponible ? 1 : 0.4
                    }}
                  >
                    {formatHora(slot.inicio)}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal de confirmación */}
        {slotPendiente && recursoSel && (
          <div
            className="ek-modal-backdrop"
            onClick={() => !submitting && setSlotPendiente(null)}
          >
            <div className="ek-modal" onClick={(e) => e.stopPropagation()}>
              <div className="ek-modal-handle" />
              <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>CONFIRMAR RESERVA</p>
              <h3 className="ek-display-md" style={{ marginBottom: '8px' }}>{recursoSel.nombre}</h3>
              <p className="ek-body-muted" style={{ marginBottom: '20px' }}>
                {slotPendiente.inicio.toLocaleDateString('es-MX', {
                  weekday: 'long', day: 'numeric', month: 'long'
                })}
                <br />
                {formatHora(slotPendiente.inicio)} – {formatHora(slotPendiente.fin)}
              </p>

              {maxInvitados > 0 && (
                <div className="ek-form-field" style={{ marginBottom: '1rem' }}>
                  <label className="ek-label">
                    Invitados ({invitados} de {maxInvitados} disponibles)
                  </label>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <button
                      type="button"
                      onClick={() => setInvitados(Math.max(0, invitados - 1))}
                      disabled={invitados === 0}
                      className="ek-cta ek-cta--secondary"
                      style={{ minHeight: '40px', minWidth: '40px', padding: '0 0.75rem' }}
                    >
                      −
                    </button>
                    <span style={{
                      fontSize: '1.5rem',
                      fontWeight: 700,
                      minWidth: '40px',
                      textAlign: 'center'
                    }}>
                      {invitados}
                    </span>
                    <button
                      type="button"
                      onClick={() => setInvitados(Math.min(maxInvitados, invitados + 1))}
                      disabled={invitados === maxInvitados}
                      className="ek-cta ek-cta--secondary"
                      style={{ minHeight: '40px', minWidth: '40px', padding: '0 0.75rem' }}
                    >
                      +
                    </button>
                  </div>
                  <p className="ek-helper-text">
                    Total de personas en la grabación: {1 + invitados}
                  </p>
                </div>
              )}

              {error && (
                <p className="ek-error-text" style={{ marginBottom: '1rem' }}>{error}</p>
              )}

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={() => setSlotPendiente(null)}
                  disabled={submitting}
                  className="ek-cta ek-cta--secondary"
                  style={{ flex: 1 }}
                >
                  Cancelar
                </button>
                <button
                  onClick={confirmarReserva}
                  disabled={submitting}
                  className="ek-cta"
                  style={{ flex: 1 }}
                >
                  {submitting ? 'Reservando…' : 'Confirmar'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
