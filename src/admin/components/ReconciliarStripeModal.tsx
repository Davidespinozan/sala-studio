import { useEffect, useState } from 'react';
import { backendPost } from '@shared/lib/backend';
import { useTenant } from '@shared/hooks/useTenant';

/**
 * W6-C2 — Reconciliación ON-DEMAND con Stripe (solo lectura).
 * Muestra verdad interna vs verdad Stripe y la clasificación. No repara nada:
 * no hay acciones económicas en este panel.
 */

type Sujeto = 'pago' | 'membresia' | 'socio';

interface EconView { gross: number; refunded: number; disputed_lost: number; net: number; currency: string; state: string }
interface Detalle {
  pago_id: string; referencia: string | null; kind: string; result: string; discrepancies: string[];
  internal: EconView | null; stripe: EconView | null;
  disputas: Array<{ estado: string; monto_centavos: number | null }>;
  evidence: { pendingInbox: boolean; recent: boolean };
}
interface Resumen { total_payments: number; match: number; explained_differences: number; mismatches: number; manual_review: number; unknown: number; overall: string }
interface Respuesta { consultado_en: string; detalles: Detalle[]; resumen?: Resumen; result?: string }

const RESULTADO: Record<string, { titulo: string; ayuda: string; ok: boolean }> = {
  MATCH: { titulo: 'Coincide', ayuda: 'Stripe y SALA dicen lo mismo.', ok: true },
  EXPLAINED_DIFFERENCE: { titulo: 'Diferencia transitoria', ayuda: 'Hay un evento en camino o el cobro es muy reciente. Vuelve a consultar en unos minutos.', ok: true },
  MISSING_INTERNAL: { titulo: 'Falta en SALA', ayuda: 'Stripe tiene el cobro pero SALA no lo registró.', ok: false },
  MISSING_STRIPE: { titulo: 'No existe en Stripe', ayuda: 'SALA tiene el cobro pero Stripe confirma que ese objeto no existe.', ok: false },
  AMOUNT_MISMATCH: { titulo: 'El monto no coincide', ayuda: 'El monto o la moneda son distintos en Stripe y en SALA.', ok: false },
  REFUND_MISMATCH: { titulo: 'El reembolso no coincide', ayuda: 'Lo reembolsado en Stripe es distinto de lo asentado en SALA.', ok: false },
  DISPUTE_MISMATCH: { titulo: 'El contracargo no coincide', ayuda: 'El contracargo perdido en Stripe no cuadra con SALA.', ok: false },
  OWNERSHIP_MISMATCH: { titulo: 'El cobro no pertenece a este socio', ayuda: 'El cliente de Stripe no corresponde. Requiere revisión.', ok: false },
  STATE_MISMATCH: { titulo: 'El estado no coincide', ayuda: 'El dinero cuadra pero el estado es distinto.', ok: false },
  INSUFFICIENT_EVIDENCE: { titulo: 'Sin evidencia suficiente', ayuda: 'No hay datos para comparar este cobro.', ok: false },
  MANUAL_REVIEW: { titulo: 'Requiere revisión manual', ayuda: 'Hay una diferencia que no se puede clasificar sola.', ok: false },
  NOT_FOUND: { titulo: 'Sin referencia de Stripe', ayuda: 'Este cobro no tiene un objeto de Stripe que consultar.', ok: false },
  NOT_ACCESSIBLE: { titulo: 'Stripe no dio acceso', ayuda: 'No se pudo leer el cobro en Stripe. No significa que no exista.', ok: false },
  UNKNOWN: { titulo: 'No se pudo consultar', ayuda: 'Stripe no respondió. Intenta de nuevo; no significa que no exista.', ok: false }
};

const ESTADO: Record<string, string> = {
  succeeded: 'Cobrado', partially_refunded: 'Reembolso parcial', refunded: 'Reembolsado', disputed_lost: 'Contracargo perdido'
};
const CAMPO: Record<string, string> = {
  gross: 'monto cobrado', refunded: 'reembolsado', disputed_lost: 'contracargo', currency: 'moneda', state: 'estado'
};

const money = (c: number, m: string) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: (m || 'MXN').toUpperCase() }).format(c / 100);

function Columna({ titulo, v }: { titulo: string; v: EconView | null }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <p className="ek-eyebrow" style={{ margin: '0 0 6px' }}>{titulo}</p>
      {v ? (
        <dl style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
          <div>Cobrado: <strong>{money(v.gross, v.currency)}</strong></div>
          <div>Reembolsado: {money(v.refunded, v.currency)}</div>
          <div>Contracargo: {money(v.disputed_lost, v.currency)}</div>
          <div>Neto: <strong>{money(v.net, v.currency)}</strong></div>
          <div>Estado: {ESTADO[v.state] ?? v.state}</div>
        </dl>
      ) : (
        <p style={{ fontSize: 13, color: 'var(--sala-text-tertiary)', margin: 0 }}>Sin datos</p>
      )}
    </div>
  );
}

export function ReconciliarStripeModal({ sujeto, id, onClose }: { sujeto: Sujeto; id: string; onClose: () => void }) {
  const [data, setData] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const tenant = useTenant();
  const tenantId = tenant?.id ?? null;

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const res = await backendPost<Respuesta>('reconciliar-stripe', { sujeto, id, tenant_id: tenantId });
        if (!cancelado) setData(res);
      } catch (e) {
        if (!cancelado) setError(e instanceof Error ? e.message : 'No se pudo consultar Stripe');
      } finally {
        if (!cancelado) setCargando(false);
      }
    })();
    return () => { cancelado = true; };
  }, [sujeto, id, tenantId]);

  return (
    <div className="ek-modal-backdrop" onClick={onClose}>
      <div className="ek-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="ek-modal-handle" />
        <h3 className="ek-h3" style={{ marginBottom: 4 }}>
          {sujeto === 'pago' ? 'Reconciliar con Stripe' : 'Verificar pagos Stripe'}
        </h3>
        <p style={{ fontSize: 12, color: 'var(--sala-text-tertiary)', margin: '0 0 14px', lineHeight: 1.45 }}>
          Solo consulta. No cambia cobros, reembolsos ni membresías.
        </p>

        {cargando && <p className="ek-body-muted">Consultando Stripe…</p>}
        {error && <p style={{ fontSize: 13, color: 'var(--sala-text-secondary)' }}>{error}</p>}

        {data && (
          <>
            {data.resumen && (
              <div className="ek-card" style={{ padding: 12, marginBottom: 12 }}>
                <p className="ek-eyebrow" style={{ margin: '0 0 6px' }}>RESUMEN</p>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
                  {data.resumen.total_payments} cobros · {data.resumen.match} coinciden
                  {data.resumen.explained_differences > 0 && ` · ${data.resumen.explained_differences} transitorios`}
                  {data.resumen.mismatches > 0 && ` · ${data.resumen.mismatches} con diferencia`}
                  {data.resumen.manual_review > 0 && ` · ${data.resumen.manual_review} a revisar`}
                  {data.resumen.unknown > 0 && ` · ${data.resumen.unknown} sin consultar`}
                </p>
                <p style={{ margin: '6px 0 0', fontSize: 13, fontWeight: 700, color: data.resumen.overall === 'MATCH' ? 'var(--sala-primary)' : 'var(--sala-accent)' }}>
                  {data.resumen.overall === 'MATCH' ? 'Todo coincide' : data.resumen.overall === 'UNKNOWN' ? 'Hay cobros que no se pudieron consultar' : 'Hay diferencias que revisar'}
                </p>
              </div>
            )}

            {data.detalles.length === 0 && (
              <p className="ek-body-muted">No hay cobros de Stripe para comparar.</p>
            )}

            <div style={{ display: 'grid', gap: 10, maxHeight: '52vh', overflowY: 'auto' }}>
              {data.detalles.map((d) => {
                const r = RESULTADO[d.result] ?? RESULTADO.MANUAL_REVIEW;
                return (
                  <div key={d.pago_id} className="ek-card" style={{ padding: 12 }}>
                    <p style={{ margin: '0 0 2px', fontSize: 14, fontWeight: 700, color: r.ok ? 'var(--sala-primary)' : 'var(--sala-accent)' }}>
                      {r.titulo}
                    </p>
                    <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--sala-text-secondary)', lineHeight: 1.45 }}>{r.ayuda}</p>
                    <div style={{ display: 'flex', gap: 16 }}>
                      <Columna titulo="EN SALA" v={d.internal} />
                      <Columna titulo="EN STRIPE" v={d.stripe} />
                    </div>
                    {d.discrepancies.length > 0 && (
                      <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--sala-text-secondary)' }}>
                        Diferencia en: {d.discrepancies.map((x) => CAMPO[x] ?? x).join(', ')}
                      </p>
                    )}
                    <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--sala-text-tertiary)' }}>
                      Evidencia: {d.referencia ? `referencia ${d.referencia}` : 'sin referencia de Stripe'}
                      {d.disputas.length > 0 && ` · ${d.disputas.length} contracargo(s) registrado(s)`}
                      {d.evidence.pendingInbox && ' · evento en proceso'}
                    </p>
                  </div>
                );
              })}
            </div>

            <p style={{ margin: '12px 0 0', fontSize: 11, color: 'var(--sala-text-tertiary)' }}>
              Consultado: {new Date(data.consultado_en).toLocaleString('es-MX')}
            </p>
          </>
        )}

        <button type="button" className="ek-cta ek-cta--secondary" onClick={onClose} style={{ marginTop: 14, width: '100%' }}>
          Cerrar
        </button>
      </div>
    </div>
  );
}
