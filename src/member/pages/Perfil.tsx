import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, CalendarCheck, Check, ChevronRight, CreditCard, Fingerprint, LifeBuoy, Plus, RotateCcw, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Avatar } from '@shared/components/Avatar';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { useLandingConfig } from '@shared/hooks/useLandingConfig';
import { supabase } from '@shared/lib/supabase';
import { gymCobraOnline } from '@shared/lib/cobrosDelGym';
import type { Database } from '@shared/types/database';
import { useMembresiaActual, membresiaEstado } from '@member/hooks/useMembresiaActual';
import { PlanTipoToggle, type VistaPlan } from '@shared/components/PlanTipoToggle';
import { ActivarAvisosPush } from '@shared/components/ActivarAvisosPush';
import { useHuellasSocio } from '@shared/hooks/useHuellasSocio';
import { nombreDedo } from '@shared/lib/dedos';
import { useMemberSucursal } from '@member/providers/MemberSucursalProvider';
import { iniciarCheckout } from '@shared/lib/checkout';
import { backendPost } from '@shared/lib/backend';
import { CheckoutModal } from '@shared/components/CheckoutModal';

type Tier = Database['public']['Tables']['tiers']['Row'];

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

/** "Miembro desde junio 2026" a partir de usuarios.created_at. */
function formatearMiembroDesde(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const fecha = new Date(iso).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
  return `Miembro desde ${fecha}`;
}

function formatearFechaCorta(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatearPrecio(centavos: number, moneda: string): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: moneda || 'MXN',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(centavos / 100);
}

/** Tiers activos del tenant, ordenados. Lectura vía RLS tiers_read_tenant. */
function useTiersDelTenant() {
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data } = await supabase
        .from('tiers')
        .select('*')
        .eq('activo', true)
        .order('orden', { ascending: true });
      if (mounted) {
        setTiers((data ?? []) as Tier[]);
        setIsLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, []);

  return { tiers, isLoading };
}


export default function Perfil() {
  const { authUser, usuario, signOut } = useAuth();
  const tenant = useTenant();
  const cobraOnline = gymCobraOnline(tenant);
  const { sesionesEsteMes } = useStatsDelMes(usuario?.id);
  const { membresia, isLoading: loadingMembresia } = useMembresiaActual(usuario?.id);
  const { tiers } = useTiersDelTenant();
  const { whatsappUrl } = useLandingConfig();

  const miembroDesde = formatearMiembroDesde(usuario?.created_at);
  const ayudaUrl = whatsappUrl('Hola, necesito ayuda con mi cuenta.');

  const nombreFormat = usuario?.nombre
    ?.toLowerCase()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') ?? '';


  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <div className="ek-stack-md">
          <p className="ek-eyebrow">PERFIL</p>
          <h1 className="ek-display-md">{nombreFormat || 'Tu cuenta'}</h1>
        </div>

        {/* Avatar + antigüedad */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <Avatar
            src={usuario?.avatar_url}
            nombre={usuario?.nombre}
            email={usuario?.email}
            size={120}
            fallbackBg="var(--ek-mustard)"
            fallbackColor="var(--ek-bg)"
            style={{ border: '0.5px solid var(--ek-line)' }}
          />

          {miembroDesde && (
            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                letterSpacing: '0.03em',
                color: 'var(--sala-text-tertiary)'
              }}
            >
              {miembroDesde}
            </span>
          )}
        </div>

        {/* Mis datos */}
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
        </div>

        {/* Plan: avisos + hero + método de pago + opciones + historial + cancelar + FAQ */}
        <AvisosPlan membresia={membresia} tenantNombre={tenant.nombre} />
        <PlanHero
          membresia={membresia}
          loading={loadingMembresia}
          tiers={tiers}
          tenantNombre={tenant.nombre}
        />
        {/* Avisos en el teléfono: sin esto, el socio solo se entera si abre la app. */}
        {usuario?.id && (
          <div style={{ marginTop: '20px' }}>
            <ActivarAvisosPush
              usuarioId={usuario.id}
              tenantId={tenant.id}
              descripcion="Recordatorios de tus clases, avisos si se cancela una, y cuando tu plan esté por vencer."
            />
          </div>
        )}

        {/* Un gym que cobra en efectivo no tiene tarjetas que gestionar: mostrarle
            "Método de pago" al socio es ofrecerle un botón que no lleva a ningún lado. */}
        {cobraOnline && <MetodoPago />}
        <PlanActualYOpciones membresia={membresia} tiers={tiers} tenantNombre={tenant.nombre} />
        <HistorialPagos />
        {membresia && !membresia.cancelada_at && (
          <CancelarSuscripcion tenantNombre={tenant.nombre} />
        )}
        <FaqPlan cobraOnline={cobraOnline} tenantNombre={tenant.nombre} />

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

        {/* Su huella. Solo aparece si la dio: al que nunca puso el dedo no le
            sirve de nada leer sobre esto. */}
        {usuario?.id && <MiHuella usuarioId={usuario.id} tenantNombre={tenant.nombre} />}

        {/* Ajustes */}
        <section>
          <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>AJUSTES</p>
          <div className="ek-stack-sm">
            <AjusteRow
              icon={<CalendarCheck size={18} strokeWidth={2} />}
              label="Mis reservas"
              to="/app/historial"
            />
            {ayudaUrl && (
              <AjusteRow
                icon={<LifeBuoy size={18} strokeWidth={2} />}
                label="Ayuda y soporte"
                href={ayudaUrl}
              />
            )}
          </div>
        </section>

        {/* Cerrar sesión — al fondo */}
        <button
          onClick={signOut}
          className="ek-cta ek-cta--secondary ek-cta--full"
          style={{ marginTop: '8px' }}
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}

/**
 * La huella del socio, en su app.
 *
 * Es SU dedo: tiene que poder ver qué guardó el gimnasio y borrarlo sin pedirle
 * permiso a nadie. Borrarlo acá borra la plantilla de verdad (no la esconde), y
 * el lector deja de reconocerlo en la próxima sincronización.
 */
function MiHuella({ usuarioId, tenantNombre }: { usuarioId: string; tenantNombre: string }) {
  const { huellas, refetch } = useHuellasSocio(usuarioId);
  const [borrando, setBorrando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (huellas.length === 0) return null;

  async function borrar() {
    setBorrando(true);
    setError(null);
    try {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string,
        params?: Record<string, unknown>
      ) => Promise<{ error: { message: string } | null }>;

      // Sin p_usuario_id, la función usa el del que llama: es su propia huella.
      const { error: err } = await rpc('revocar_huella_socio', {});
      if (err) throw new Error(err.message.replace(/^[A-Z_]+:\s*/, ''));
      await refetch();
      setConfirmando(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos borrar tu huella');
    } finally {
      setBorrando(false);
    }
  }

  return (
    <section style={{ marginBottom: '24px' }}>
      <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>TU HUELLA</p>
      <div className="ek-card ek-card--md">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Fingerprint size={20} strokeWidth={2} style={{ color: 'var(--sala-primary)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>
              {huellas.length === 1
                ? `Tenés ${nombreDedo(huellas[0].dedo).toLowerCase()} registrado`
                : `Tenés ${huellas.length} dedos registrados`}
            </p>
            <p style={{ margin: '4px 0 0', fontSize: '12.5px', color: 'var(--sala-text-secondary)', lineHeight: 1.5 }}>
              Entrás a {tenantNombre} apoyando el dedo, sin sacar el celular.
            </p>
          </div>
        </div>

        {confirmando ? (
          <div style={{ marginTop: '14px' }}>
            <p style={{ margin: '0 0 10px', fontSize: '12.5px', lineHeight: 1.5 }}>
              Si la borrás, {tenantNombre} deja de tenerla y vas a tener que volver al mostrador
              si querés usarla otra vez. Vas a poder seguir entrando con tu código QR.
            </p>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="ek-cta ek-cta--secondary"
                style={{ flex: 1, fontSize: '13px' }}
                onClick={() => setConfirmando(false)}
                disabled={borrando}
              >
                Mejor no
              </button>
              <button
                className="ek-cta"
                style={{ flex: 1, fontSize: '13px' }}
                onClick={() => void borrar()}
                disabled={borrando}
              >
                {borrando ? 'Borrando…' : 'Sí, borrarla'}
              </button>
            </div>
          </div>
        ) : (
          <button
            className="ek-cta ek-cta--secondary ek-cta--full"
            style={{ marginTop: '14px', fontSize: '13px' }}
            onClick={() => setConfirmando(true)}
          >
            Borrar mi huella
          </button>
        )}

        {error && (
          <p style={{ margin: '10px 0 0', fontSize: '12px', color: 'var(--sala-error)' }}>{error}</p>
        )}
      </div>
    </section>
  );
}

/** Fila de la lista de ajustes: ícono + label + chevron. Link interno o link externo (href). */
function AjusteRow({
  icon,
  label,
  to,
  href
}: {
  icon: ReactNode;
  label: string;
  to?: string;
  href?: string;
}) {
  const style: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    textDecoration: 'none'
  };
  const inner = (
    <>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '36px',
          height: '36px',
          borderRadius: '10px',
          background: 'var(--sala-primary-light)',
          color: 'var(--sala-primary)',
          flexShrink: 0
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1, fontSize: '15px', fontWeight: 600, color: 'var(--sala-text-primary)' }}>
        {label}
      </span>
      <ChevronRight size={18} strokeWidth={2} style={{ color: 'var(--sala-text-tertiary)' }} />
    </>
  );
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="ek-card ek-card--md ek-lift" style={style}>
        {inner}
      </a>
    );
  }
  return (
    <Link to={to!} className="ek-card ek-card--md ek-lift" style={style}>
      {inner}
    </Link>
  );
}

// ============================================================================
// Mi suscripción
// ============================================================================

/**
 * Avisos que exigen una acción del socio, arriba de todo: si no los ve, pierde
 * el acceso sin enterarse. Antes no existía ninguno — un pago rechazado era
 * invisible hasta que la membresía moría.
 */
function AvisosPlan({
  membresia,
  tenantNombre
}: {
  membresia: ReturnType<typeof useMembresiaActual>['membresia'];
  tenantNombre: string;
}) {
  const toast = useToast();
  const [tarjetaAbierta, setTarjetaAbierta] = useState(false);
  const [reactivando, setReactivando] = useState(false);
  if (!membresia) return null;

  const pagoVencido = membresia.status === 'past_due';
  const cancelaAlFin = !!membresia.cancelada_at;
  if (!pagoVencido && !cancelaAlFin) return null;

  async function reactivar() {
    setReactivando(true);
    try {
      const res = await backendPost<{ ok?: boolean }>('cancelar-membresia', { reactivar: true });
      if (res.ok) {
        toast.success('¡Listo! Tu plan se va a renovar normalmente.');
        setTimeout(() => window.location.reload(), 900);
        return;
      }
      toast.error(`No pudimos reactivarlo. Habla con ${tenantNombre}.`);
    } catch {
      toast.error('No pudimos reactivarlo. Probá de nuevo.');
    } finally {
      setReactivando(false);
    }
  }

  const fin = membresia.cancelada_efectiva_at ?? membresia.periodo_actual_fin;

  return (
    <section style={{ marginTop: '16px' }}>
      {pagoVencido && (
        <div
          role="alert"
          className="ek-card"
          style={{
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start',
            borderColor: 'var(--sala-error)',
            background: 'var(--sala-error-bg)',
            marginBottom: cancelaAlFin ? '12px' : 0
          }}
        >
          <AlertTriangle size={18} style={{ color: 'var(--sala-error)', flexShrink: 0, marginTop: '2px' }} />
          <div style={{ flex: 1 }}>
            <p style={{ margin: 0, fontWeight: 700, fontSize: '14px' }}>Tu último pago no se procesó</p>
            <p style={{ margin: '4px 0 10px', fontSize: '13px', color: 'var(--sala-text-secondary)', lineHeight: 1.5 }}>
              Actualizá tu tarjeta para no perder el acceso al gimnasio.
            </p>
            <button
              type="button"
              className="ek-cta"
              style={{ padding: '9px 16px', fontSize: '13px' }}
              onClick={() => setTarjetaAbierta(true)}
            >
              Actualizar tarjeta
            </button>
          </div>
        </div>
      )}

      {cancelaAlFin && (
        <div
          className="ek-card"
          style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', borderColor: 'var(--sala-warning)', background: 'var(--sala-warning-bg)' }}
        >
          <AlertTriangle size={18} style={{ color: 'var(--sala-warning)', flexShrink: 0, marginTop: '2px' }} />
          <div style={{ flex: 1 }}>
            <p style={{ margin: 0, fontWeight: 700, fontSize: '14px' }}>
              Tu plan se cancela{fin ? ` el ${formatearFechaCorta(fin)}` : ' al terminar el periodo'}
            </p>
            <p style={{ margin: '4px 0 10px', fontSize: '13px', color: 'var(--sala-text-secondary)', lineHeight: 1.5 }}>
              Seguís con acceso hasta esa fecha. Podés reactivarlo cuando quieras.
            </p>
            <button
              type="button"
              className="ek-cta"
              style={{ padding: '9px 16px', fontSize: '13px' }}
              onClick={() => void reactivar()}
              disabled={reactivando}
            >
              {reactivando ? 'Reactivando…' : 'Reactivar plan'}
              {!reactivando && <RotateCcw size={15} strokeWidth={2.25} />}
            </button>
          </div>
        </div>
      )}

      {tarjetaAbierta && (
        <CheckoutModal
          modo="tarjeta"
          onClose={() => setTarjetaAbierta(false)}
          onSuccess={() => {
            setTarjetaAbierta(false);
            toast.success('¡Tarjeta actualizada!');
            setTimeout(() => window.location.reload(), 900);
          }}
        />
      )}
    </section>
  );
}

/** Etiqueta del estado real de la membresía, con su tono. */
function EstadoBadge({ estado }: { estado: ReturnType<typeof membresiaEstado> }) {
  const META: Record<string, { texto: string; color: string }> = {
    sana: { texto: 'Activa', color: 'rgba(255, 255, 255, 0.9)' },
    past_due: { texto: 'Pago vencido', color: 'var(--sala-error)' },
    vencida: { texto: 'Vencida', color: 'var(--sala-warning)' },
    congelada: { texto: 'Pausada', color: 'var(--sala-warning)' },
    sin_creditos: { texto: 'Sin clases', color: 'var(--sala-warning)' },
    sin_membresia: { texto: 'Sin plan', color: 'rgba(255, 255, 255, 0.7)' }
  };
  const m = META[estado] ?? META.sana;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '5px 12px',
        borderRadius: '999px',
        background: 'rgba(255, 255, 255, 0.08)',
        border: '1px solid rgba(255, 255, 255, 0.14)',
        color: m.color,
        fontSize: '11px',
        fontWeight: 800,
        letterSpacing: '0.08em',
        textTransform: 'uppercase'
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} aria-hidden="true" />
      {m.texto}
    </span>
  );
}

function PlanHero({
  membresia,
  loading,
  tiers,
  tenantNombre
}: {
  membresia: ReturnType<typeof useMembresiaActual>['membresia'];
  loading: boolean;
  tiers: Tier[];
  tenantNombre: string;
}) {
  const estado = membresiaEstado(membresia);
  const tierActual = membresia ? tiers.find((t) => t.id === membresia.tier_id) ?? null : null;
  const esCreditos = membresia?.tier_tipo === 'creditos' || membresia?.tier_tipo === 'hibrido';
  const [comprando, setComprando] = useState(false);

  // Sede + alcance del plan (solo gyms con 2+ sedes).
  const { sucursales, multisede } = useMemberSucursal();
  const sedeNombre = membresia?.sucursal_id
    ? sucursales.find((s) => s.id === membresia.sucursal_id)?.nombre ?? null
    : null;
  const accesoTexto = membresia
    ? membresia.tier_acceso_todas_sucursales
      ? 'todas las sedes'
      : sedeNombre
        ? `solo ${sedeNombre}`
        : null
    : null;

  return (
    <section style={{ marginTop: '8px' }}>
      <div
        style={{
          borderRadius: 'var(--ek-r-card)',
          padding: '24px',
          background: 'var(--grad-immersive)',
          boxShadow: '0 12px 32px rgba(10, 15, 12, 0.28)',
          overflow: 'hidden'
        }}
      >
        {loading ? (
          <div className="ek-skeleton" style={{ height: '76px', borderRadius: '12px', opacity: 0.35 }} />
        ) : membresia ? (
          <>
            {/* Nombre del plan + ESTADO. Antes solo se veía el nombre: un socio
                en pago vencido o congelado no tenía forma de saberlo desde acá. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '16px' }}>
              <span
                style={{
                  display: 'inline-block',
                  padding: '5px 12px',
                  borderRadius: '999px',
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: '1px solid rgba(255, 255, 255, 0.14)',
                  color: 'rgba(255, 255, 255, 0.92)',
                  fontSize: '11px',
                  fontWeight: 800,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase'
                }}
              >
                {membresia.tier_nombre}
              </span>
              <EstadoBadge estado={estado} />
            </div>

            <p
              style={{
                fontSize: '20px',
                fontWeight: 600,
                lineHeight: 1.35,
                color: 'rgba(255, 255, 255, 0.92)',
                margin: 0
              }}
            >
              {esCreditos ? (
                <>
                  Te quedan{' '}
                  <strong style={{ color: 'rgba(255, 255, 255, 0.97)', fontWeight: 800 }}>
                    {membresia.creditos_restantes ?? 0}{' '}
                    {(membresia.creditos_restantes ?? 0) === 1 ? 'clase' : 'clases'}
                  </strong>
                  .
                </>
              ) : membresia.periodo_actual_fin ? (
                <>
                  {estado === 'vencida' ? 'Tu plan venció el ' : 'Tu plan se renueva el '}
                  <strong style={{ color: 'rgba(255, 255, 255, 0.97)', fontWeight: 800 }}>
                    {formatearFechaCorta(membresia.periodo_actual_fin)}
                  </strong>
                  .
                </>
              ) : (
                'Tu plan está activo.'
              )}
            </p>

            {tierActual && (
              <p style={{ fontSize: '14px', color: 'rgba(255, 255, 255, 0.55)', margin: '10px 0 0' }}>
                {formatearPrecio(tierActual.precio_centavos, tierActual.moneda)}
              </p>
            )}

            {esCreditos && tierActual && (
              <button
                type="button"
                onClick={() => setComprando(true)}
                className="ek-cta"
                style={{ marginTop: '16px', width: '100%', background: 'rgba(255,255,255,0.96)', color: 'var(--sala-primary)' }}
              >
                {(membresia.creditos_restantes ?? 0) <= 0 ? 'Comprar otro paquete' : 'Comprar más clases'}
              </button>
            )}

            {multisede && (sedeNombre || accesoTexto) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '16px' }}>
                {sedeNombre && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '999px', background: 'rgba(255, 255, 255, 0.08)', border: '1px solid rgba(255, 255, 255, 0.14)', color: 'rgba(255, 255, 255, 0.85)', fontSize: '12px', fontWeight: 600 }}>
                    Sede: {sedeNombre}
                  </span>
                )}
                {accesoTexto && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '999px', background: 'rgba(255, 255, 255, 0.08)', border: '1px solid rgba(255, 255, 255, 0.14)', color: 'rgba(255, 255, 255, 0.85)', fontSize: '12px', fontWeight: 600 }}>
                    Acceso: {accesoTexto}
                  </span>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <p style={{ fontSize: '20px', fontWeight: 600, color: 'rgba(255, 255, 255, 0.92)', margin: 0 }}>
              No tienes un plan activo
            </p>
            <p style={{ fontSize: '14px', color: 'rgba(255, 255, 255, 0.55)', margin: '8px 0 0', lineHeight: 1.5 }}>
              Habla con {tenantNombre} para activar tu plan y empezar a reservar.
            </p>
          </>
        )}
      </div>

      {comprando && membresia && (
        <CheckoutModal
          tierId={membresia.tier_id}
          onClose={() => setComprando(false)}
          onSuccess={() => {
            setComprando(false);
            setTimeout(() => window.location.reload(), 1500);
          }}
        />
      )}
    </section>
  );
}

// ============================================================================
// Plan actual y opciones
// ============================================================================

function PlanActualYOpciones({
  membresia,
  tiers,
  tenantNombre
}: {
  membresia: ReturnType<typeof useMembresiaActual>['membresia'];
  tiers: Tier[];
  tenantNombre: string;
}) {
  const toast = useToast();
  const [enProceso, setEnProceso] = useState(false);
  const [abierto, setAbierto] = useState(false);
  const [vistaPlan, setVistaPlan] = useState<VistaPlan>('membresias');
  // Pasar de un paquete con clases restantes a una mensualidad las descarta:
  // que sea una decisión consciente, no una sorpresa.
  const [confirmarPerdida, setConfirmarPerdida] = useState<Tier | null>(null);

  if (tiers.length === 0) return null;

  const tieneMembresia = !!membresia;
  const esPaquete = (t: Tier) => t.tipo === 'creditos' || t.tipo === 'hibrido';
  const planesMensuales = tiers.filter((t) => !esPaquete(t));
  const planesPaquetes = tiers.filter((t) => esPaquete(t));
  const hayAmbosTipos = planesMensuales.length > 0 && planesPaquetes.length > 0;
  const vista: VistaPlan =
    vistaPlan === 'paquetes' && planesPaquetes.length > 0
      ? 'paquetes'
      : planesMensuales.length > 0
        ? 'membresias'
        : 'paquetes';
  const planesVisibles = vista === 'membresias' ? planesMensuales : planesPaquetes;
  const creditos = membresia?.creditos_restantes ?? 0;

  const suscribir = async (tier: Tier) => {
    if (enProceso) return;
    // Aviso previo: paquete con saldo → mensualidad = perdés las clases.
    const veniaDePaquete =
      membresia?.tier_tipo === 'creditos' || membresia?.tier_tipo === 'hibrido';
    if (veniaDePaquete && creditos > 0 && !esPaquete(tier)) {
      setConfirmarPerdida(tier);
      return;
    }
    setEnProceso(true);
    try {
      const res = await iniciarCheckout(tier.id);
      if (res.url) return; // redirigió a Stripe
      if (res.activated) {
        toast.success(`¡Listo! Tu plan ${tier.nombre} quedó activo.`);
        setTimeout(() => window.location.reload(), 900);
        return;
      }
      toast.info(`El pago online está en camino. Por ahora, habla con ${tenantNombre} para activar tu plan.`);
      setEnProceso(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No pudimos procesar la suscripción.');
      setEnProceso(false);
    }
  };

  return (
    <section style={{ marginTop: '20px' }}>
      {/* Un solo botón. Antes acá se listaban TODAS las tarjetas de planes: el
          perfil quedaba en una pared de opciones donde no se distinguía cuál era
          el tuyo. Elegir plan es una tarea puntual → va en un modal. */}
      <button
        type="button"
        onClick={() => {
          setVistaPlan(
            membresia && (membresia.tier_tipo === 'creditos' || membresia.tier_tipo === 'hibrido')
              ? 'paquetes'
              : 'membresias'
          );
          setAbierto(true);
        }}
        className="ek-cta ek-cta--full ek-lift"
      >
        {tieneMembresia ? 'Cambiar de plan' : 'Elegir un plan'}
        <ArrowRight size={16} strokeWidth={2.25} />
      </button>

      {abierto && (
        <div
          className="ek-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Cambiar de plan"
          onClick={() => setAbierto(false)}
        >
          <div
            className="ek-card"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '440px', width: '100%', maxHeight: '86vh', overflowY: 'auto' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <p className="ek-eyebrow">{tieneMembresia ? 'CAMBIAR DE PLAN' : 'ELEGIR UN PLAN'}</p>
              <button
                type="button"
                className="ek-icon-btn"
                aria-label="Cerrar"
                onClick={() => setAbierto(false)}
              >
                <X size={18} />
              </button>
            </div>

            {hayAmbosTipos && (
              <div style={{ marginBottom: '16px' }}>
                <PlanTipoToggle value={vista} onChange={setVistaPlan} />
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {planesVisibles.map((tier) => (
                <PlanOptionCard
                  key={tier.id}
                  tier={tier}
                  esActual={membresia?.tier_id === tier.id}
                  tieneMembresia={tieneMembresia}
                  enProceso={enProceso}
                  onCambiar={() => void suscribir(tier)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {confirmarPerdida && (
        <div className="ek-backdrop" role="dialog" aria-modal="true" onClick={() => setConfirmarPerdida(null)}>
          <div className="ek-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px', width: '100%' }}>
            <p className="ek-eyebrow" style={{ color: 'var(--sala-error)', marginBottom: '8px' }}>
              PERDÉS TUS CLASES
            </p>
            <h3 style={{ margin: '0 0 8px', fontSize: '20px', fontWeight: 700 }}>
              Te quedan {creditos} {creditos === 1 ? 'clase' : 'clases'}
            </h3>
            <p style={{ margin: '0 0 18px', fontSize: '14px', color: 'var(--sala-text-secondary)', lineHeight: 1.5 }}>
              <strong>{confirmarPerdida.nombre}</strong> es una mensualidad, así que tu saldo de
              clases <strong>se pierde</strong>. Si querés aprovecharlas, usalas antes de cambiar.
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                type="button"
                className="ek-cta ek-cta--secondary ek-cta--full"
                onClick={() => setConfirmarPerdida(null)}
              >
                Mejor no
              </button>
              <button
                type="button"
                className="ek-cta ek-cta--full"
                onClick={() => {
                  const destino = confirmarPerdida;
                  setConfirmarPerdida(null);
                  setEnProceso(true);
                  void (async () => {
                    try {
                      const res = await iniciarCheckout(destino.id);
                      if (res.url) return;
                      if (res.activated) {
                        toast.success(`¡Listo! Tu plan ${destino.nombre} quedó activo.`);
                        setTimeout(() => window.location.reload(), 900);
                        return;
                      }
                      toast.info(`El pago online está en camino. Habla con ${tenantNombre}.`);
                      setEnProceso(false);
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : 'No pudimos procesar la suscripción.');
                      setEnProceso(false);
                    }
                  })();
                }}
              >
                Continuar igual
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function PlanOptionCard({
  tier,
  esActual,
  tieneMembresia,
  enProceso,
  onCambiar
}: {
  tier: Tier;
  esActual: boolean;
  tieneMembresia: boolean;
  enProceso: boolean;
  onCambiar: () => void;
}) {
  const beneficios = Array.isArray(tier.beneficios)
    ? (tier.beneficios as Array<{ label?: string; incluido?: boolean }>).filter(
        (b) => b && typeof b.label === 'string' && b.incluido !== false
      )
    : [];

  return (
    <div
      className="ek-card"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        border: esActual ? '2px solid var(--sala-primary)' : '1px solid var(--sala-border)',
        background: esActual ? 'var(--sala-primary-light)' : 'var(--sala-surface)'
      }}
    >
      {esActual && (
        <span
          style={{
            position: 'absolute',
            top: '12px',
            right: '12px',
            padding: '4px 10px',
            borderRadius: '999px',
            background: 'var(--sala-primary)',
            color: 'var(--sala-text-on-primary)',
            fontSize: '10px',
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase'
          }}
        >
          Actual
        </span>
      )}

      <h3
        style={{
          fontSize: '12px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--sala-text-secondary)',
          margin: 0
        }}
      >
        {tier.nombre}
      </h3>
      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '26px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          margin: '6px 0 0',
          color: 'var(--sala-text-primary)'
        }}
      >
        {formatearPrecio(tier.precio_centavos, tier.moneda)}
      </p>

      {!esActual && beneficios.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            margin: '14px 0 0',
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '7px'
          }}
        >
          {beneficios.slice(0, 3).map((b, i) => (
            <li
              key={i}
              style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '13px', color: 'var(--sala-text-primary)' }}
            >
              <Check size={15} strokeWidth={2.5} style={{ color: 'var(--sala-primary)', flexShrink: 0, marginTop: '1px' }} />
              {b.label}
            </li>
          ))}
        </ul>
      )}

      {!esActual && (
        <button
          type="button"
          onClick={onCambiar}
          disabled={enProceso}
          className="ek-cta ek-lift ek-cta--full"
          style={{ marginTop: 'auto', paddingTop: '12px', paddingBottom: '12px', fontSize: '13px', opacity: enProceso ? 0.6 : 1 }}
        >
          {enProceso ? 'Procesando…' : tieneMembresia ? 'Cambiar' : 'Suscribirme'}
          {!enProceso && <ArrowRight size={15} strokeWidth={2.25} />}
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Método de pago
// ============================================================================

interface TarjetaGuardada {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

function MetodoPago() {
  const [card, setCard] = useState<TarjetaGuardada | null>(null);
  const [loading, setLoading] = useState(true);
  const [showTarjeta, setShowTarjeta] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const res = await backendPost<{ card: TarjetaGuardada | null }>('metodo-pago', { action: 'get' });
        if (!cancel) setCard(res.card ?? null);
      } catch {
        if (!cancel) setCard(null);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [reload]);

  return (
    <section style={{ marginTop: '32px' }}>
      <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>MÉTODO DE PAGO</p>

      {loading ? (
        <div className="ek-skeleton" style={{ height: '84px', borderRadius: 'var(--ek-r-card)' }} aria-hidden="true" />
      ) : card ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '18px 20px', background: 'var(--sala-surface)', border: '1px solid var(--sala-border)', borderRadius: 'var(--ek-r-card)' }}>
          <div aria-hidden="true" style={{ width: '44px', height: '44px', borderRadius: '10px', background: 'var(--sala-primary-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <CreditCard size={20} strokeWidth={2} style={{ color: 'var(--sala-primary)' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: '15px', fontWeight: 600, margin: 0, color: 'var(--sala-text-primary)', textTransform: 'capitalize' }}>
              {card.brand} ···· {card.last4}
            </p>
            <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '2px 0 0' }}>
              Vence {String(card.exp_month).padStart(2, '0')}/{String(card.exp_year).slice(-2)}
            </p>
          </div>
          <button type="button" onClick={() => setShowTarjeta(true)} className="ek-cta ek-cta--secondary" style={{ minHeight: '36px' }}>
            Cambiar
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '14px', padding: '28px 20px', background: 'var(--sala-bg)', border: '1.5px dashed var(--sala-border-strong)', borderRadius: 'var(--ek-r-card)' }}>
          <div aria-hidden="true" style={{ width: '48px', height: '48px', borderRadius: '12px', background: 'var(--sala-primary-light)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CreditCard size={22} strokeWidth={2} style={{ color: 'var(--sala-primary)' }} />
          </div>
          <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', margin: 0 }}>
            No tienes una tarjeta guardada.
          </p>
          <button type="button" onClick={() => setShowTarjeta(true)} className="ek-cta ek-lift ek-cta--full">
            Agregar tarjeta
            <ArrowRight size={16} strokeWidth={2.25} />
          </button>
        </div>
      )}

      {showTarjeta && (
        <CheckoutModal
          modo="tarjeta"
          onClose={() => setShowTarjeta(false)}
          onSuccess={() => { setShowTarjeta(false); setReload((r) => r + 1); }}
        />
      )}
    </section>
  );
}

// ============================================================================
// Historial de pagos
// ============================================================================

interface PagoHist {
  id: string;
  amount: number;
  currency: string;
  created: number;
  status: string;
  descripcion: string | null;
}

function HistorialPagos() {
  const [pagos, setPagos] = useState<PagoHist[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await backendPost<{ pagos: PagoHist[] }>('metodo-pago', { action: 'historial' });
        if (!cancel) setPagos(res.pagos ?? []);
      } catch {
        if (!cancel) setPagos([]);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, []);

  return (
    <section style={{ marginTop: '32px' }}>
      <p className="ek-eyebrow" style={{ marginBottom: '10px' }}>HISTORIAL DE PAGOS</p>
      {loading ? (
        <div className="ek-skeleton" style={{ height: '64px', borderRadius: 'var(--ek-r-card)' }} aria-hidden="true" />
      ) : pagos.length === 0 ? (
        <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', margin: 0, lineHeight: 1.5 }}>
          Todavía no tienes pagos.
        </p>
      ) : (
        <div className="ek-stack-sm">
          {pagos.map((p) => (
            <div
              key={p.id}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '14px 16px', background: 'var(--sala-surface)', border: '1px solid var(--sala-border)', borderRadius: 'var(--ek-r-card)' }}
            >
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: '14px', fontWeight: 600, margin: 0, color: 'var(--sala-text-primary)' }}>
                  ${(p.amount / 100).toLocaleString('es-MX')} {p.currency.toUpperCase()}
                </p>
                <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '2px 0 0' }}>
                  {new Date(p.created * 1000).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })}
                  {p.descripcion ? ` · ${p.descripcion}` : ''}
                </p>
              </div>
              <span
                style={{ flexShrink: 0, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '4px 10px', borderRadius: '999px', color: p.status === 'succeeded' ? 'var(--sala-success)' : 'var(--sala-error)', background: p.status === 'succeeded' ? 'var(--sala-success-bg)' : 'var(--sala-error-bg)' }}
              >
                {p.status === 'succeeded' ? 'Pagado' : p.status === 'failed' ? 'Falló' : p.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ============================================================================
// Cancelar suscripción
// ============================================================================

function CancelarSuscripcion({ tenantNombre }: { tenantNombre: string }) {
  const toast = useToast();
  const [confirmando, setConfirmando] = useState(false);
  const [cancelando, setCancelando] = useState(false);

  async function cancelar() {
    setCancelando(true);
    try {
      const res = await backendPost<{ ok?: boolean; reason?: string }>('cancelar-membresia', { reactivar: false });
      if (res.ok) {
        toast.success('Listo: tu plan se cancela al final del período ya pagado.');
      } else if (res.reason === 'sin_suscripcion') {
        toast.info('Tu plan es un paquete de clases — no se cancela, se agota al usar las clases.');
      } else if (res.reason === 'stripe_pendiente') {
        toast.info(`Para cancelar tu plan, habla con ${tenantNombre}.`);
      } else {
        toast.error('No pudimos cancelar. Probá de nuevo.');
      }
    } catch {
      toast.error('No pudimos cancelar. Probá de nuevo.');
    } finally {
      setCancelando(false);
      setConfirmando(false);
    }
  }

  if (confirmando) {
    return (
      <div style={{ marginTop: '24px', padding: '16px', borderRadius: 'var(--ek-r-card)', background: 'var(--sala-bg)', border: '1px solid var(--sala-border-strong)' }}>
        <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '0 0 12px', lineHeight: 1.5 }}>
          ¿Seguro? Conservás el acceso hasta el final del período ya pagado; después tu plan no se renueva.
        </p>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" onClick={() => setConfirmando(false)} disabled={cancelando} className="ek-cta ek-cta--secondary" style={{ flex: 1 }}>
            Volver
          </button>
          <button type="button" onClick={cancelar} disabled={cancelando} className="ek-cta" style={{ flex: 1, background: 'var(--sala-error)', borderColor: 'var(--sala-error)' }}>
            {cancelando ? 'Cancelando…' : 'Sí, cancelar'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirmando(true)}
      className="ek-cta ek-cta--secondary ek-cta--full"
      style={{ marginTop: '24px', color: 'var(--sala-text-secondary)' }}
    >
      Cancelar suscripción
    </button>
  );
}

// ============================================================================
// FAQ del plan
// ============================================================================

/**
 * Las respuestas dependen de CÓMO cobra el gym. Antes eran una constante que
 * afirmaba "podés cambiar de plan cuando quieras desde acá mismo" y "agregá tu
 * tarjeta en Método de pago": falso para todo gym que cobra en efectivo, que es
 * la mayoría de los que arrancan.
 */
function faqDelPlan(cobraOnline: boolean, tenantNombre: string): Array<{ q: string; a: string }> {
  const faq = [
    {
      q: '¿Cuándo se hace el cobro?',
      a: cobraOnline
        ? 'Si es mensualidad, al renovar en la fecha que ves arriba. Si es un paquete de clases, pagas una vez y se descuenta una clase por reserva.'
        : `El cobro se hace en el mostrador de ${tenantNombre}. Si es mensualidad, al renovar en la fecha que ves arriba; si es un paquete, pagas una vez y se descuenta una clase por reserva.`
    },
    {
      q: '¿Qué pasa si cancelo?',
      a: 'Conservas el acceso hasta el final del período ya pagado. Después, tu plan no se renueva. (Los paquetes no se cancelan: se agotan al usar las clases.)'
    },
    {
      q: '¿Puedo cambiar de plan cuando quiera?',
      a: cobraOnline
        ? 'Sí, desde las opciones de plan acá mismo.'
        : `Sí. Pedilo en el mostrador de ${tenantNombre} y te lo cambian ahí.`
    }
  ];

  if (cobraOnline) {
    faq.push({
      q: '¿Cómo agrego o cambio mi tarjeta?',
      a: 'Desde "Método de pago", acá en tu perfil.'
    });
  }

  return faq;
}

function FaqPlan({ cobraOnline, tenantNombre }: { cobraOnline: boolean; tenantNombre: string }) {
  return (
    <section style={{ marginTop: '32px' }}>
      <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>PREGUNTAS FRECUENTES</p>
      <div className="ek-stack-sm">
        {faqDelPlan(cobraOnline, tenantNombre).map((f) => (
          <FaqItem key={f.q} q={f.q} a={f.a} />
        ))}
      </div>
    </section>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ek-card" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '16px 18px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left'
        }}
      >
        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--sala-text-primary)' }}>{q}</span>
        <Plus
          size={18}
          strokeWidth={2.25}
          style={{
            flexShrink: 0,
            color: 'var(--sala-accent)',
            transition: 'transform 0.2s ease',
            transform: open ? 'rotate(45deg)' : 'rotate(0deg)'
          }}
        />
      </button>
      {open && (
        <p
          style={{
            fontSize: '13px',
            color: 'var(--sala-text-secondary)',
            lineHeight: 1.55,
            margin: 0,
            padding: '0 18px 16px'
          }}
        >
          {a}
        </p>
      )}
    </div>
  );
}
