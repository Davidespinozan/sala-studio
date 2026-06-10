import { useState } from 'react';
import { useToast } from '@shared/hooks/useToast';
import { cancelarSuscripcion } from '../lib/suscripcionService';
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
  const [confirmando, setConfirmando] = useState(false);
  const [cancelando, setCancelando] = useState(false);

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
            ? 'Tu suscripción está cancelada. Elegí un plan abajo para reactivarla.'
            : 'Todavía no elegiste un plan. Mirá las opciones abajo y empezá tu prueba gratis.'}
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

  async function handleCancelar() {
    if (!suscripcion) return;
    setCancelando(true);
    const { error } = await cancelarSuscripcion(suscripcion.id);
    setCancelando(false);
    setConfirmando(false);
    if (error) {
      toast.error('No pudimos cancelar la suscripción. Probá de nuevo.');
      return;
    }
    toast.success('Suscripción cancelada. (modo demo)');
    onCambio();
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
                  ? `Pasaste el límite de tu plan (${uso.miembrosActuales}/${uso.limite}). Subí a ${PLANES_SAAS[tierSiguiente].nombre} para sumar más miembros sin problemas.`
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

      {/* Acción cancelar */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--sala-border)', paddingTop: '14px' }}>
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
      </div>

      <ConfirmDialog
        isOpen={confirmando}
        variant="danger"
        title="¿Cancelar tu suscripción?"
        description="Perdés el acceso a las funciones de tu plan al terminar el período actual. Podés volver a suscribirte cuando quieras. (Modo demo — no se procesa ningún reembolso real.)"
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
