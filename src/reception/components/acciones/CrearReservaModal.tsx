import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { supabase } from '@shared/lib/supabase';
import { AccionModal } from '@shared/components/AccionModal';
import { useToast } from '@shared/hooks/useToast';
import { useReceptionSucursal } from '../../providers/ReceptionSucursalProvider';
import { translateActionError } from '../../lib/traducirErrorAccion';
import { SeleccionarLugar } from '@member/components/SeleccionarLugar';
import { useLugaresSala } from '@member/hooks/useLugaresSala';
import { useTenant } from '@shared/hooks/useTenant';
import { getTenantTimezone, hoyEnTimezone, sumarDias, instanteDeClase } from '@shared/lib/timezone';
import { InvitadosForm } from '@shared/components/InvitadosForm';
import { guardarInvitados, ajustarInvitados, type InvitadoDetalle } from '@shared/lib/invitados';

/**
 * WALK-IN — recepción inscribe a un socio en una clase.
 *
 * Antes, un socio que llegaba sin reserva simplemente no podía entrar: no había
 * forma de crear una reserva desde el mostrador. La RPC recepcion_crear_reserva
 * mantiene todas las reglas (membresía viva, plan con acceso a la sala, cupo,
 * créditos, invitados) y solo levanta la anticipación mínima — que es justamente
 * lo que hace imposible un walk-in.
 */

interface ClaseOpcion {
  clase_id: string | null;
  horario_recurrente_id: string | null;
  fecha: string;
  hora_inicio: string;
  duracion_minutos: number | null;
  nombre: string;
  cupo_max: number;
  reservados: number;
  recurso_id: string;
  recurso_nombre: string | null;
  instructor_nombre: string | null;
}

interface PaseTier {
  id: string;
  nombre: string;
  precio_centavos: number;
  moneda: string | null;
}

const METODOS: { value: 'efectivo' | 'tarjeta' | 'transferencia'; label: string }[] = [
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'tarjeta', label: 'Tarjeta' },
  { value: 'transferencia', label: 'Transferencia' }
];

function dinero(centavos: number, moneda: string | null): string {
  return (centavos / 100).toLocaleString('es-MX', { style: 'currency', currency: moneda ?? 'MXN' });
}

interface Props {
  socioId: string;
  socioNombre: string;
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

/** Los próximos 7 días, empezando hoy EN LA ZONA DEL GYM (no la del navegador:
 *  recepción puede estar en otra tz y "hoy" es el de la sede). */
function proximosDias(tz: string, n = 7): { iso: string; label: string }[] {
  const out: { iso: string; label: string }[] = [];
  const hoyISO = hoyEnTimezone(tz);
  for (let i = 0; i < n; i++) {
    const iso = sumarDias(hoyISO, i);
    let label: string;
    if (i === 0) label = 'Hoy';
    else if (i === 1) label = 'Mañana';
    else {
      // Etiqueta (día de semana) sin que la tz del navegador la corra: se lee la
      // fecha como mediodía UTC y se formatea en UTC.
      const [y, m, d] = iso.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d, 12));
      label = dt.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
    }
    out.push({ iso, label });
  }
  return out;
}

function stepBtn(disabled: boolean): CSSProperties {
  return {
    width: '34px', height: '34px', borderRadius: '999px',
    border: '1px solid var(--sala-border)', background: 'var(--sala-surface)',
    fontSize: '18px', fontWeight: 700, lineHeight: 1,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
    color: 'var(--sala-text-primary)', fontFamily: 'inherit'
  };
}

export function CrearReservaModal({ socioId, socioNombre, isOpen, onClose, onDone }: Props) {
  const toast = useToast();
  const { sucursalId } = useReceptionSucursal();
  const tenant = useTenant();
  const tz = getTenantTimezone(tenant);
  const dias = useMemo(() => proximosDias(tz), [tz]);
  const [fecha, setFecha] = useState(dias[0].iso);
  const [clases, setClases] = useState<ClaseOpcion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [elegida, setElegida] = useState<ClaseOpcion | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Bolsa de pases de invitado del SOCIO (no del staff). Un recepcionista puede
  // consultarla: invitados_disponibles es SECURITY DEFINER y lo permite.
  const [invitadosDisponibles, setInvitadosDisponibles] = useState(0);
  const [invitados, setInvitados] = useState(0);
  const [invitadosDetalle, setInvitadosDetalle] = useState<InvitadoDetalle[]>([]);
  // Day pass: cuando el plan del socio no cubre ese día, la reserva falla con
  // DIA_NO_PERMITIDO y ofrecemos venderle un pase suelto (sin tocar su plan).
  const [pases, setPases] = useState<PaseTier[]>([]);
  const [pasePanel, setPasePanel] = useState(false);
  const [paseTierId, setPaseTierId] = useState<string | null>(null);
  const [metodoPago, setMetodoPago] = useState<'efectivo' | 'tarjeta' | 'transferencia'>('efectivo');
  const [cobrando, setCobrando] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setCargando(true);
    setElegida(null);
    (async () => {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        name: string, args: Record<string, unknown>
      ) => Promise<{ data: ClaseOpcion[] | null; error: { message: string } | null }>;
      const { data, error } = await rpc('expandir_clases', {
        p_sucursal_id: sucursalId, p_desde: fecha, p_hasta: fecha
      });
      if (cancelled) return;
      if (error) toast.error('No pudimos cargar las clases de ese día.');
      // Para HOY se ocultan solo las que ya TERMINARON: una clase en curso sigue
      // disponible hasta su último minuto — el walk-in que llega tarde también
      // cuenta (numa: llegaban con day pass ya empezada la clase y no se podía).
      const ahora = Date.now();
      const rows = (data ?? []).filter((c) => {
        if (fecha !== dias[0].iso) return true;
        // El instante de la clase se calcula en la ZONA DEL GYM, no la del
        // navegador: si no, desde otra tz las clases de hoy se ven "ya pasadas".
        const inicio = instanteDeClase(c.fecha, c.hora_inicio, tz).getTime();
        return inicio + (c.duracion_minutos ?? 60) * 60_000 >= ahora;
      });
      setClases(rows);
      setCargando(false);
    })();
    return () => { cancelled = true; };
  }, [isOpen, fecha, sucursalId, toast, dias, tz]);

  // Pases de invitado que le quedan al socio este periodo (alimenta el stepper).
  useEffect(() => {
    if (!isOpen) { setInvitadosDisponibles(0); setInvitados(0); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc('invitados_disponibles', { p_usuario_id: socioId });
      if (cancelled) return;
      const d = (data ?? {}) as { disponibles?: number };
      setInvitadosDisponibles(d.disponibles ?? 0);
    })();
    return () => { cancelled = true; };
  }, [isOpen, socioId]);

  // Pases sueltos del gym (es_pase). Se cobran cuando el día cae fuera del plan.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      const from = supabase.from.bind(supabase) as unknown as (
        t: string
      ) => {
        select: (c: string) => {
          eq: (k: string, v: unknown) => {
            eq: (k: string, v: unknown) => {
              eq: (k: string, v: unknown) => {
                order: (c: string, o: { ascending: boolean }) => Promise<{ data: PaseTier[] | null }>;
              };
            };
          };
        };
      };
      const { data } = await from('tiers')
        .select('id, nombre, precio_centavos, moneda')
        .eq('tenant_id', tenant.id)
        .eq('es_pase', true)
        .eq('activo', true)
        .order('precio_centavos', { ascending: true });
      if (cancelled) return;
      const rows = data ?? [];
      setPases(rows);
      setPaseTierId((prev) => prev ?? rows[0]?.id ?? null);
    })();
    return () => { cancelled = true; };
  }, [isOpen, tenant.id]);

  // Mapa de salón: si la sala de la clase elegida usa lugares, hay que elegir uno.
  // Mismo hook que usa el socio y el mapa de recepción (una sola fuente de verdad).
  const { layout, tomados } = useLugaresSala(elegida?.recurso_id, elegida?.clase_id ?? null);
  const [lugarId, setLugarId] = useState<string | null>(null);

  // Walk-in: si la clase elegida es de hoy y ya empezó (o empieza en <30 min),
  // se ofrece hacer el check-in en el mismo paso — prendido por default cuando
  // la clase ya está corriendo (el socio obviamente está aquí).
  const [checkInYa, setCheckInYa] = useState(false);
  const elegidaInicio = elegida ? instanteDeClase(elegida.fecha, elegida.hora_inicio, tz).getTime() : null;
  const puedeCheckIn =
    !!elegida && elegida.fecha === dias[0].iso &&
    elegidaInicio !== null && elegidaInicio <= Date.now() + 30 * 60_000;

  useEffect(() => {
    setLugarId(null);
    setInvitados(0);
    setPasePanel(false); // al cambiar de clase, se cierra el panel de day pass
    const inicio = elegida ? instanteDeClase(elegida.fecha, elegida.hora_inicio, tz).getTime() : null;
    setCheckInYa(!!elegida && elegida.fecha === dias[0].iso && inicio !== null && inicio <= Date.now());
  }, [elegida, dias, tz]);
  // La lista de datos de invitados sigue al conteo del stepper.
  useEffect(() => { setInvitadosDetalle((prev) => ajustarInvitados(prev, invitados)); }, [invitados]);

  async function confirmar() {
    if (!elegida) return;
    setEnviando(true);
    try {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        name: string, args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
      const { data, error } = await rpc('recepcion_crear_reserva', {
        p_usuario_id: socioId,
        p_clase_id: elegida.clase_id,
        p_horario_id: elegida.clase_id ? null : elegida.horario_recurrente_id,
        p_fecha: elegida.clase_id ? null : elegida.fecha,
        p_invitados: invitados,
        p_notas: 'Walk-in en mostrador',
        p_lugar_id: lugarId,
        p_motivo: 'Walk-in en mostrador'
      });
      if (error) {
        // El plan no cubre ese día: en vez de un toast muerto, ofrecemos venderle
        // un day pass (sin tocar su plan). El resto de errores sí se muestran.
        if (error.message.includes('DIA_NO_PERMITIDO')) {
          setEnviando(false);
          if (pases.length === 0) {
            toast.error('El plan del socio no incluye ese día y no hay un Day Pass configurado para cobrarle.');
            return;
          }
          setPasePanel(true);
          return;
        }
        toast.error(translateActionError(error.message));
        setEnviando(false);
        return;
      }
      // Guardar la identidad de los invitados (best-effort: la reserva ya existe).
      const reservaId = (data as { reserva_id?: string } | null)?.reserva_id;
      if (reservaId && invitados > 0) {
        try {
          await guardarInvitados({ reservaId, tenantId: tenant.id, invitados: invitadosDetalle });
        } catch {
          toast.error('Reserva creada, pero no pudimos guardar los datos del invitado.');
        }
      }
      // Check-in inmediato (walk-in): la reserva ya existe; si el check-in
      // falla se avisa, pero no se pierde nada.
      if (reservaId && checkInYa && puedeCheckIn) {
        const { error: errCheckin } = await supabase.rpc('check_in_manual_atomic', {
          p_reserva_id: reservaId,
          p_motivo: 'Walk-in en mostrador'
        });
        if (errCheckin) {
          toast.error('Reserva creada, pero el check-in no pasó: ' + translateActionError(errCheckin.message));
        } else {
          toast.success(`Listo: ${socioNombre} reservado y con check-in.`);
        }
      } else {
        toast.success(`Reserva creada para ${socioNombre}.`);
      }
      await onDone();
      onClose();
    } catch {
      toast.error('No pudimos crear la reserva. Intenta de nuevo.');
    } finally {
      setEnviando(false);
    }
  }

  // Cobra un day pass y crea la reserva del día que su plan no cubre. El socio
  // CONSERVA su plan: no se crea membresía; solo entra un cobro suelto a la Caja.
  async function confirmarPaseDia() {
    if (!elegida || !paseTierId) return;
    setCobrando(true);
    try {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        name: string, args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
      const { data, error } = await rpc('recepcion_reservar_pase_dia', {
        p_usuario_id: socioId,
        p_metodo_pago: metodoPago,
        p_pase_tier_id: paseTierId,
        p_clase_id: elegida.clase_id,
        p_horario_id: elegida.clase_id ? null : elegida.horario_recurrente_id,
        p_fecha: elegida.clase_id ? null : elegida.fecha,
        p_lugar_id: lugarId,
        p_motivo: 'Day pass — día fuera de su plan'
      });
      if (error) {
        toast.error(translateActionError(error.message));
        setCobrando(false);
        return;
      }
      const res = data as { reserva?: { reserva_id?: string } } | null;
      const reservaId = res?.reserva?.reserva_id;
      // Check-in inmediato si ya está aquí (mismo criterio que el walk-in normal).
      if (reservaId && checkInYa && puedeCheckIn) {
        const { error: errCheckin } = await supabase.rpc('check_in_manual_atomic', {
          p_reserva_id: reservaId,
          p_motivo: 'Walk-in con day pass'
        });
        if (errCheckin) {
          toast.error('Day pass cobrado y reserva creada, pero el check-in no pasó: ' + translateActionError(errCheckin.message));
        } else {
          toast.success(`Day pass cobrado. ${socioNombre} reservado y con check-in.`);
        }
      } else {
        toast.success(`Day pass cobrado. Reserva creada para ${socioNombre}.`);
      }
      await onDone();
      onClose();
    } catch {
      toast.error('No pudimos cobrar el day pass. Intenta de nuevo.');
    } finally {
      setCobrando(false);
    }
  }

  const faltaLugar = !!layout && !lugarId;
  // Invitados: solo en salas SIN mapa (las de mapa los bloquean por diseño) y si
  // al socio le quedan pases. El techo respeta además el cupo libre de la clase
  // (el socio ocupa 1 lugar; el resto puede ser para invitados).
  const libresElegida = elegida ? elegida.cupo_max - elegida.reservados : 0;
  const maxInvitados = layout ? 0 : Math.min(invitadosDisponibles, Math.max(libresElegida - 1, 0));
  const mostrarInvitados = !!elegida && !layout && invitadosDisponibles > 0;
  const paseSel = pases.find((p) => p.id === paseTierId) ?? null;

  return (
    <AccionModal
      isOpen={isOpen}
      title="Crear reserva"
      description={`Inscribes a ${socioNombre} en una clase. Se descuenta su crédito si el plan es por clases.`}
      variant="info"
      confirmLabel={
        pasePanel
          ? cobrando
            ? 'Cobrando…'
            : paseSel
              ? `Cobrar ${dinero(paseSel.precio_centavos, paseSel.moneda)} y reservar`
              : 'Cobrar y reservar'
          : enviando ? 'Reservando…' : 'Reservar'
      }
      canConfirm={
        pasePanel
          ? !!paseTierId && !cobrando
          : !!elegida && !faltaLugar && !enviando
      }
      onConfirm={pasePanel ? confirmarPaseDia : confirmar}
      onClose={onClose}
    >
      {/* Day pass: el plan no cubre ese día → cobrar un pase suelto sin tocar el plan */}
      {pasePanel && elegida && (
        <div
          style={{
            marginBottom: '14px',
            padding: '14px',
            borderRadius: '10px',
            border: '1px solid var(--sala-primary)',
            background: 'var(--sala-primary-light)'
          }}
        >
          <p style={{ margin: '0 0 4px', fontSize: '13px', fontWeight: 700 }}>
            El plan de {socioNombre} no incluye los{' '}
            {new Date(`${elegida.fecha}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'long' })}
          </p>
          <p style={{ margin: '0 0 12px', fontSize: '12px', color: 'var(--sala-text-secondary)', lineHeight: 1.5 }}>
            Véndele un day pass para que entre a <strong>{elegida.nombre}</strong> ({elegida.hora_inicio.slice(0, 5)}).
            Conserva su plan; se registra el cobro en la Caja.
          </p>

          {/* Qué pase (si hay más de uno) */}
          {pases.length > 1 && (
            <div style={{ marginBottom: '12px' }}>
              <p className="ek-label" style={{ marginBottom: '4px' }}>Pase</p>
              <select
                className="ek-input"
                value={paseTierId ?? ''}
                onChange={(e) => setPaseTierId(e.target.value)}
              >
                {pases.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre} — {dinero(p.precio_centavos, p.moneda)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Cómo se cobró */}
          <p className="ek-label" style={{ marginBottom: '6px' }}>¿Cómo se cobró?</p>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {METODOS.map((m) => {
              const activo = metodoPago === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMetodoPago(m.value)}
                  style={{
                    padding: '8px 14px',
                    borderRadius: '999px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    background: activo ? 'var(--grad-primary)' : 'var(--sala-surface)',
                    color: activo ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)',
                    border: `1px solid ${activo ? 'var(--sala-primary)' : 'var(--sala-border)'}`
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => setPasePanel(false)}
            style={{
              marginTop: '12px',
              background: 'none',
              border: 'none',
              padding: 0,
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--sala-text-secondary)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              textDecoration: 'underline'
            }}
          >
            ← Elegir otra clase
          </button>
        </div>
      )}

      {/* Día */}
      <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px', marginBottom: '14px' }}>
        {dias.map((d) => {
          const activo = d.iso === fecha;
          return (
            <button
              key={d.iso}
              type="button"
              onClick={() => setFecha(d.iso)}
              style={{
                padding: '8px 14px',
                borderRadius: '999px',
                fontSize: '13px',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                fontFamily: 'inherit',
                background: activo ? 'var(--grad-primary)' : 'var(--sala-surface)',
                color: activo ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)',
                border: `1px solid ${activo ? 'var(--sala-primary)' : 'var(--sala-border)'}`
              }}
            >
              {d.label}
            </button>
          );
        })}
      </div>

      {/* Clases del día */}
      {cargando ? (
        <div className="ek-skeleton" style={{ height: '140px', borderRadius: '10px' }} />
      ) : clases.length === 0 ? (
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', textAlign: 'center', padding: '18px 0', margin: 0 }}>
          No hay clases disponibles ese día.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '260px', overflowY: 'auto' }}>
          {clases.map((c) => {
            const libres = c.cupo_max - c.reservados;
            const lleno = libres <= 0;
            const sel = elegida?.clase_id
              ? elegida.clase_id === c.clase_id
              : elegida?.horario_recurrente_id === c.horario_recurrente_id && elegida?.fecha === c.fecha;
            return (
              <button
                key={`${c.clase_id ?? c.horario_recurrente_id}-${c.fecha}-${c.hora_inicio}`}
                type="button"
                disabled={lleno}
                onClick={() => setElegida(c)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: '10px',
                  cursor: lleno ? 'not-allowed' : 'pointer',
                  opacity: lleno ? 0.45 : 1,
                  fontFamily: 'inherit',
                  background: sel ? 'var(--sala-primary-light)' : 'var(--sala-surface)',
                  border: `1px solid ${sel ? 'var(--sala-primary)' : 'var(--sala-border)'}`
                }}
              >
                <span style={{ fontWeight: 700, fontSize: '13px', minWidth: '52px', fontVariantNumeric: 'tabular-nums' }}>
                  {c.hora_inicio.slice(0, 5)}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600, fontSize: '13px' }}>{c.nombre}</span>
                  <span style={{ display: 'block', fontSize: '11px', color: 'var(--sala-text-tertiary)' }}>
                    {c.recurso_nombre ?? 'Sala'}
                    {c.instructor_nombre ? ` · ${c.instructor_nombre}` : ''}
                  </span>
                </span>
                <span style={{ fontSize: '11px', fontWeight: 600, color: lleno ? 'var(--sala-error)' : 'var(--sala-text-secondary)' }}>
                  {lleno ? 'Llena' : `${libres} libre${libres === 1 ? '' : 's'}`}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Walk-in: reservar y hacer check-in en un solo paso */}
      {puedeCheckIn && (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginTop: '14px',
            padding: '10px 12px',
            borderRadius: '10px',
            background: 'var(--sala-primary-light)',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          <input type="checkbox" checked={checkInYa} onChange={(e) => setCheckInYa(e.target.checked)} />
          Hacer check-in de una vez (ya está aquí)
        </label>
      )}

      {/* Invitados: recepción suma los pases del socio (si su plan los incluye) */}
      {mostrarInvitados && (
        <div style={{ marginTop: '14px' }}>
          <p className="ek-label" style={{ marginBottom: '4px' }}>Invitados</p>
          <p style={{ fontSize: '12px', color: 'var(--sala-text-secondary)', margin: '0 0 8px' }}>
            Le quedan {invitadosDisponibles} pase{invitadosDisponibles === 1 ? '' : 's'} de invitado este periodo.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              type="button"
              onClick={() => setInvitados((n) => Math.max(0, n - 1))}
              disabled={invitados <= 0}
              style={stepBtn(invitados <= 0)}
              aria-label="Quitar invitado"
            >−</button>
            <span style={{ minWidth: '24px', textAlign: 'center', fontWeight: 700, fontSize: '16px', fontVariantNumeric: 'tabular-nums' }}>
              {invitados}
            </span>
            <button
              type="button"
              onClick={() => setInvitados((n) => Math.min(maxInvitados, n + 1))}
              disabled={invitados >= maxInvitados}
              style={stepBtn(invitados >= maxInvitados)}
              aria-label="Agregar invitado"
            >+</button>
            {maxInvitados === 0 && (
              <span style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)' }}>
                Sin cupo para invitados en esta clase
              </span>
            )}
          </div>
          {invitados > 0 && (
            <div style={{ marginTop: '12px' }}>
              <InvitadosForm count={invitados} value={invitadosDetalle} onChange={setInvitadosDetalle} />
            </div>
          )}
        </div>
      )}

      {/* Mapa de salón: si la sala lo usa, hay que elegir lugar sí o sí. */}
      {layout && (
        <div style={{ marginTop: '14px' }}>
          <p className="ek-label" style={{ marginBottom: '8px' }}>Elegí el lugar</p>
          <SeleccionarLugar
            layout={layout}
            tomados={tomados}
            seleccionado={lugarId}
            onSelect={setLugarId}
          />
        </div>
      )}
    </AccionModal>
  );
}
