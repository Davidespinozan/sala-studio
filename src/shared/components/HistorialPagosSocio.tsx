import { useEffect, useState } from 'react';
import { Receipt } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { ReciboModal } from './ReciboModal';
import { conceptoLabel, metodoLabel, montoFmt } from '@shared/lib/recibo';

interface PagoRow {
  id: string;
  created_at: string;
  concepto: string;
  monto_centavos: number;
  moneda: string;
  metodo: string;
  tier: { nombre: string | null } | null;
}

/**
 * Historial de pagos de UN socio, para la ficha (admin/recepción). Lee el ledger
 * `pagos` (RLS pagos_read_staff lo acota al gym) y da el botón "Recibo" en cada
 * cobro real — el más reciente queda arriba, así justo tras cobrar aparece ahí
 * con su recibo. Cortesías y reembolsos no ofrecen recibo de pago.
 *
 * `reloadKey`: cámbialo desde la ficha (p. ej. tras un cobro) para refrescar.
 */
export function HistorialPagosSocio({ usuarioId, reloadKey }: { usuarioId: string; reloadKey?: number | string }) {
  const [pagos, setPagos] = useState<PagoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reciboId, setReciboId] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    (async () => {
      const { data } = await supabase
        .from('pagos')
        .select('id, created_at, concepto, monto_centavos, moneda, metodo, tier:tiers(nombre)')
        .eq('usuario_id', usuarioId)
        .order('created_at', { ascending: false })
        .limit(30);
      if (!cancel) {
        setPagos((data ?? []) as unknown as PagoRow[]);
        setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [usuarioId, reloadKey]);

  if (loading) {
    return <div className="ek-skeleton" style={{ height: 72, borderRadius: 12 }} aria-hidden="true" />;
  }
  if (pagos.length === 0) {
    return (
      <p style={{ fontSize: 13, color: 'var(--sala-text-tertiary)', margin: 0 }}>
        Todavía no hay cobros registrados.
      </p>
    );
  }

  return (
    <>
      <div className="ek-card" style={{ padding: 0, overflow: 'hidden' }}>
        {pagos.map((p, i) => {
          const esReembolso = p.concepto === 'reembolso';
          const sinCosto = p.metodo === 'cortesia';
          return (
            <div
              key={p.id}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: i === 0 ? 'none' : '0.5px solid var(--sala-border)' }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: esReembolso ? 'var(--sala-error)' : 'var(--sala-text-primary)' }}>
                  {esReembolso ? '−' : ''}{montoFmt(Math.abs(p.monto_centavos), p.moneda)}
                  <span style={{ fontWeight: 500, color: 'var(--sala-text-tertiary)' }}>
                    {' · '}{conceptoLabel(p.concepto, p.tier?.nombre)}
                  </span>
                </p>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--sala-text-tertiary)' }}>
                  {new Date(p.created_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })}
                  {' · '}{metodoLabel(p.metodo)}
                </p>
              </div>
              {!esReembolso && !sinCosto && (
                <button
                  type="button"
                  onClick={() => setReciboId(p.id)}
                  className="ek-cta ek-cta--secondary"
                  style={{ flexShrink: 0, minHeight: 32, padding: '0 12px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <Receipt size={14} /> Recibo
                </button>
              )}
            </div>
          );
        })}
      </div>

      {reciboId && (
        <ReciboModal pagoId={reciboId} modo="staff" onClose={() => setReciboId(null)} />
      )}
    </>
  );
}