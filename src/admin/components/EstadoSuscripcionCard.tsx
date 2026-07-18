import { useEffect, useState } from 'react';
import { CreditCard, AlertTriangle } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { useTenant } from '@shared/hooks/useTenant';
import { esTenantDemo } from '@shared/lib/demoAuth';
import {
  cancelarSuscripcion,
  cambiarCancelacionSaas,
  abrirPortalSaas,
  obtenerTarjetaSaas,
  type TarjetaSaas
} from '../lib/suscripcionService';
import {
  PLANES_SAAS,
  TIERS_ORDEN,
  formatPrecio,
  type TierSaas
} from '@shared/lib/planesSaas';
import type { SuscripcionSaas, UsoMiembros } from '../hooks/useSuscripcion';
import ConfirmDialog from './ConfirmDialog';

const DIA_MS = 24 * 60 * 60 * 1000;

const ESTADO_INFO: Record<string, { label: string; color: string; bg: string }> = {
  trial: { label: 'Prueba gratis', color: 'var(--sala-primary)', bg: 'var(--sala-primary-light)' },
  activa: { label: 'Activa', color: 'var(--sala-success)', bg: 'var(--sala-success-bg)' },
  vencida: { label: 'Pago vencido', color: 'var(--sala-error)', bg: 'var(--sala-error-bg)' },
  pausada: { label: 'Pausada', color: 'var(--sala-text-tertiary)', bg: 'var(--sala-bg)' },
  cancelada: { label: 'Cancelada', color: 'var(--sala-text-tertiary)', bg: 'var(--sala-bg)' }
};

function formatFecha(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

function siguienteTier(tier: TierSaas): TierSaas | null {
  const i = TIERS_ORDEN.indexOf(tier);
  return i >= 0 && i < TIERS_ORDEN.length - 1 ? TIERS_ORDEN[i + 1] : null;
}

export function EstadoSuscripcionCard({
  suscripcion,
  uso,
  onCambio
}: {
  suscripcion: SuscripcionSaas | null;
  uso: UsoMiembros | null;
  onCambio: () => void;
}) {
  const toast = useToast();
  const tenant = useTenant();
  const esDemo = esTenantDemo(tenant.slug);
  const [confirmando, setConfirmando] = useState(false);
  const [cancelando, setCancelando] = useState(false);
  const [reactivando, setReactivando] = useState(false);
  const [abriendoPortal, setAbriendoPortal] = useState(false);
  const [tarjeta, setTarjeta] = useState<TarjetaSaas | null>(null);

  // La suscripción nunca llegó a Stripe (o es un placeholder del checkout mock)
  // → no existe ninguna tarjeta. El dato ya está en el front, sin pedir nada.
  const subId = suscripcion?.stripe_subscription_id ?? null;
  const sinTarjeta = !subId || subId.startsWith('mock_');

  // Si sí hay suscripción real, traemos la tarjeta para mostrarla (como ekko).
  useEffect(() => {
    if (esDemo || sinTarjeta) { setTarjeta(null); return; }
    let cancelado = false;
    void (async () => {
      try {
        const { card } = await obtenerTarjetaSaas();
        if (!cancelado) setTarjeta(card);
      } catch {
        if (!cancelado) setTarjeta(null); // dato de adorno: nunca rompe la página
      }
    })();
    return () => { cancelado = true; };
  }, [esDemo, sinTarjeta, subId]);

  // Sin plan vigente → prompt para elegir uno.
  if (!suscripcion || suscripcion.estado === 'cancelada') {
    return (
      <div
        style={{
          background: 'var(--sala-surface)',
          border: '1px dashed var(--sala-border-strong)',
          borderRadius: '16px',
          padding: '20px',
          marginBottom: '24px'
        }}
      >
        <p
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--sala-text-tertiary)',
            margin: '0 0 6px'
          }}
        >
          {suscripcion?.estado === 'cancelada' ? 'Suscripción cancelada' : 'Sin plan activo'}
        </p>
        <p style={{ fontSize: '14px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.5 }}>
          {suscripcion?.estado === 'cancelada'
            ? 'Tu suscripción está cancelada. Elige un plan abajo para reactivarla.'
            : 'Todavía no elegiste un plan. Mira las opciones abajo y empieza tu prueba gratis.'}
        </p>
      </div>
    );
  }

  const plan = PLANES_SAAS[suscripcion.tier as TierSaas];
  const estadoInfo = ESTADO_INFO[suscripcion.estado] ?? ESTADO_INFO.activa;

  const diasTrial =
    suscripcion.estado === 'trial' && suscripcion.trial_termina
      ? Math.max(0, Math.ceil((new Date(suscripcion.trial_termina).getTime() - Date.now()) / DIA_MS))
      : null;

  // Barra de uso de miembros.
  const pct = uso?.porcentajeUsado ?? null;
  const barraColor = uso?.excedido
    ? 'var(--sala-error)'
    : uso?.cerca
      ? 'var(--sala-accent)'
      : 'var(--sala-primary)';

  const tierSiguiente = siguienteTier(suscripcion.tier as TierSaas);
  const cancelacionPendiente = suscripcion.cancel_at_period_end && suscripcion.estado !== 'cancelada';

  async function handleCancelar() {
    if (!suscripcion) return;
    setCancelando(true);
    try {
      if (esDemo) {
        const { error } = await cancelarSuscripcion();
        if (error) throw new Error(error);
        toast.success('Suscripción cancelada. (modo demo)');
      } else {
        const res = await cambiarCancelacionSaas(false);
        if (res.reason === 'stripe_pendiente') {
          toast.success('Pago en camino — Stripe se conecta pronto.');
        } else if (!res.ok) {
          throw new Error('cancel_failed');
        } else {
          toast.success('Listo: tu plan se cancela al final del período.');
        }
      }
      onCambio();
    } catch {
      toast.error('No pudimos cancelar la suscripción. Probá de nuevo.');
    } finally {
      setCancelando(false);
      setConfirmando(false);
    }
  }

  async function handleReactivar() {
    setReactivando(true);
    try {
      const res = await cambiarCancelacionSaas(true);
      if (!res.ok) throw new Error('reactivate_failed');
      toast.success('¡Suscripción reactivada! No se cancelará.');
      onCambio();
    } catch {
      toast.error('No pudimos reactivar. Probá de nuevo.');
    } finally {
      setReactivando(false);
    }
  }

  async function gestionarFacturacion() {
    setAbriendoPortal(true);
    try {
      const res = await abrirPortalSaas(window.location.pathname);
      if (res.url) return; // redirigiendo al portal de Stripe
      if (res.reason === 'sin_suscripcion') {
        toast.info('Todavía no hay una suscripción real para gestionar.');
      } else if (res.reason === 'portal_no_configurado') {
        toast.error('Falta activar el Customer Portal en Stripe (Settings → Billing).');
      } else if (res.reason === 'stripe_pendiente') {
        toast.info('Estamos conectando Stripe. Disponible pronto.');
      } else {
        toast.error('No pudimos abrir la facturación. Probá de nuevo.');
      }
    } catch {
      toast.error('No pudimos abrir la facturación. Probá de nuevo.');
    } finally {
      setAbriendoPortal(false);
    }
  }

  return (
    <div
      style={{
        background: 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderRadius: '16px',
        padding: '20px',
        marginBottom: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px'
      }}
    >
      {/* Encabezado: plan + estado */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '12px',
          flexWrap: 'wrap'
        }}
      >
        <div>
          <p
            style={{
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--sala-text-tertiary)',
              margin: '0 0 4px'
            }}
          >
            Tu plan
          </p>
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '24px',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: 'var(--sala-text-primary)',
              margin: 0
            }}
          >
            {plan.nombre}{' '}
            <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--sala-text-secondary)' }}>
              {formatPrecio(suscripcion.precio_centavos, suscripcion.moneda as 'mxn' | 'usd' | 'eur')}/mes
            </span>
          </p>
        </div>
        <span
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: estadoInfo.color,
            background: estadoInfo.bg,
            padding: '5px 10px',
            borderRadius: '999px'
          }}
        >
          {estadoInfo.label}
        </span>
      </div>

      {/* Trial / próximo cobro */}
      <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
        {diasTrial != null && (
          <Dato
            label="Prueba gratis"
            valor={diasTrial === 0 ? 'Termina hoy' : `${diasTrial} día${diasTrial === 1 ? '' : 's'} restantes`}
          />
        )}
        {suscripcion.periodo_actual_termina && (
          <Dato
            label={suscripcion.estado === 'trial' ? 'Primer cobro' : 'Próximo cobro'}
            valor={formatFecha(suscripcion.periodo_actual_termina)}
          />
        )}
      </div>

      {/* Pago vencido (dunning) */}
      {suscripcion.payment_past_due && (
        <AvisoLimite
          fuerte
          texto="Tu último pago no se procesó. Actualizá tu método de pago para no perder el acceso a tu plan."
        />
      )}

      {/* Cancelación programada al fin del periodo */}
      {cancelacionPendiente && (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: '10px',
            background: 'var(--sala-bg)',
            border: '1px solid var(--sala-border-strong)'
          }}
        >
          <p style={{ fontSize: '13px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.5 }}>
            <strong>Cancelación programada · </strong>
            Tu plan sigue activo hasta el{' '}
            {suscripcion.periodo_actual_termina ? formatFecha(suscripcion.periodo_actual_termina) : 'fin del período'}. Podés reactivarlo antes.
          </p>
        </div>
      )}

      {/* Uso de miembros */}
      {uso && (
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: '6px'
            }}
          >
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--sala-text-primary)' }}>
              Miembros activos
            </span>
            <span
              style={{
                fontSize: '13px',
                fontWeight: 700,
                color: barraColor,
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {uso.miembrosActuales}
              {uso.limite != null ? ` / ${uso.limite}` : ' · sin límite'}
            </span>
          </div>
          {uso.limite != null && (
            <div
              style={{
                height: '8px',
                background: 'var(--sala-bg)',
                borderRadius: '999px',
                overflow: 'hidden'
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${Math.min(100, pct ?? 0)}%`,
                  background: barraColor,
                  borderRadius: '999px',
                  transition: 'width 0.3s ease'
                }}
              />
            </div>
          )}

          {/* Avisos de límite */}
          {uso.excedido && (
            <AvisoLimite
              fuerte
              texto={
                tierSiguiente
                  ? `Pasaste el límite de tu plan (${uso.miembrosActuales}/${uso.limite}). Sube a ${PLANES_SAAS[tierSiguiente].nombre} para sumar más miembros sin problemas.`
                  : `Pasaste el límite de tu plan (${uso.miembrosActuales}/${uso.limite}).`
              }
            />
          )}
          {!uso.excedido && uso.cerca && (
            <AvisoLimite
              fuerte={false}
              texto={`Estás cerca del límite de tu plan (${uso.miembrosActuales}/${uso.limite}). Pensá en subir de plan pronto.`}
            />
          )}
        </div>
      )}

      {/* MEDIO DE PAGO. Antes no se mostraba nunca: un gym que jamás completó el
          checkout veía lo mismo que uno que sí pagó ("Prueba gratis" y los días
          restantes), y se enteraba de que no tenía tarjeta el día que el paywall
          lo cortaba. Ahora se dice explícito, y si falta se avisa antes. */}
      {!esDemo && (
        <div style={{ borderTop: '1px solid var(--sala-border)', paddingTop: '14px', marginBottom: '14px' }}>
          {sinTarjeta ? (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
              <AlertTriangle
                size={17}
                strokeWidth={2.25}
                style={{ color: 'var(--sala-accent)', flexShrink: 0, marginTop: '1px' }}
                aria-hidden="true"
              />
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: '13.5px', fontWeight: 600, color: 'var(--sala-text-primary)' }}>
                  No tenés una tarjeta registrada
                </p>
                <p style={{ margin: '3px 0 0', fontSize: '12.5px', lineHeight: 1.5, color: 'var(--sala-text-secondary)' }}>
                  {suscripcion.estado === 'trial'
                    ? 'Cuando termine tu prueba vas a perder el acceso al panel. Elegí tu plan abajo para agregarla.'
                    : 'Agregá una tarjeta para mantener tu plan activo.'}
                </p>
              </div>
            </div>
          ) : tarjeta?.last4 ? (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <CreditCard size={17} strokeWidth={2} style={{ color: 'var(--sala-text-secondary)', flexShrink: 0 }} aria-hidden="true" />
              <p style={{ margin: 0, fontSize: '13.5px', color: 'var(--sala-text-primary)' }}>
                <span style={{ textTransform: 'capitalize' }}>{tarjeta.brand ?? 'Tarjeta'}</span>
                {' •••• '}{tarjeta.last4}
                {tarjeta.exp_month && tarjeta.exp_year && (
                  <span style={{ color: 'var(--sala-text-tertiary)', fontSize: '12.5px' }}>
                    {`  ·  vence ${String(tarjeta.exp_month).padStart(2, '0')}/${String(tarjeta.exp_year).slice(-2)}`}
                  </span>
                )}
              </p>
            </div>
          ) : null}
        </div>
      )}

      {/* Acciones: facturación (portal) + reactivar/cancelar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap', borderTop: '1px solid var(--sala-border)', paddingTop: '14px' }}>
        {!esDemo ? (
          <button
            type="button"
            onClick={gestionarFacturacion}
            disabled={abriendoPortal}
            className="ek-cta ek-cta--secondary"
            style={{ minHeight: '38px' }}
          >
            {abriendoPortal ? 'Abriendo…' : 'Facturación y tarjeta'}
          </button>
        ) : (
          <span />
        )}
        {cancelacionPendiente ? (
          <button
            type="button"
            onClick={handleReactivar}
            disabled={reactivando}
            className="ek-cta"
            style={{ minHeight: '38px', opacity: reactivando ? 0.7 : 1 }}
          >
            {reactivando ? 'Reactivando…' : 'Reactivar suscripción'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmando(true)}
            style={{
              padding: '8px 16px',
              minHeight: '38px',
              background: 'transparent',
              color: 'var(--sala-error)',
              border: '1px solid var(--sala-error)',
              borderRadius: '999px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit'
            }}
          >
            Cancelar suscripción
          </button>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmando}
        variant="danger"
        title="¿Cancelar tu suscripción?"
        description={
          esDemo
            ? 'Perdés el acceso al terminar el período actual. Puedes volver a suscribirte cuando quieras. (Modo demo — no se procesa ningún reembolso real.)'
            : 'Tu plan sigue activo hasta el final del período actual y luego se cancela. No se reembolsa el período en curso. Podés reactivarlo antes de esa fecha.'
        }
        confirmLabel={cancelando ? 'Cancelando…' : 'Sí, cancelar'}
        cancelLabel="Volver"
        onConfirm={handleCancelar}
        onCancel={() => !cancelando && setConfirmando(false)}
      />
    </div>
  );
}

function Dato({ label, valor }: { label: string; valor: string }) {
  return (
    <div>
      <p
        style={{
          fontSize: '11px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--sala-text-tertiary)',
          margin: '0 0 2px'
        }}
      >
        {label}
      </p>
      <p
        style={{
          fontSize: '14px',
          fontWeight: 600,
          color: 'var(--sala-text-primary)',
          margin: 0,
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {valor}
      </p>
    </div>
  );
}

function AvisoLimite({ fuerte, texto }: { fuerte: boolean; texto: string }) {
  return (
    <div
      style={{
        marginTop: '10px',
        padding: '10px 12px',
        borderRadius: '10px',
        background: fuerte ? 'var(--sala-error-bg)' : 'var(--sala-warning-bg)',
        border: `1px solid ${fuerte ? 'var(--sala-error)' : 'var(--sala-warning-glow)'}`
      }}
    >
      <p
        style={{
          fontSize: '13px',
          color: 'var(--sala-text-primary)',
          margin: 0,
          lineHeight: 1.5
        }}
      >
        <strong style={{ color: fuerte ? 'var(--sala-error)' : 'var(--sala-warning)' }}>
          {fuerte ? 'Límite superado · ' : 'Cerca del límite · '}
        </strong>
        {texto}
      </p>
    </div>
  );
}
