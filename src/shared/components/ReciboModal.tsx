import { useEffect, useState } from 'react';
import { Printer, MessageCircle, X, Share2 } from 'lucide-react';
import { backendPost } from '@shared/lib/backend';
import { ReciboView, ReciboPrint } from './ReciboView';
import { type ReciboData, reciboUrl, waReciboUrl } from '@shared/lib/recibo';

/**
 * Modal in-app que muestra el recibo de un pago y deja imprimirlo / guardarlo en
 * PDF (window.print) o mandarlo por WhatsApp al socio (solo staff). Pide el token
 * firmado a `recibo-token` (autenticado) y arma el recibo con `recibo` (público),
 * la MISMA fuente que usa la página pública /recibo — el documento es idéntico.
 */
export function ReciboModal({
  pagoId,
  modo,
  onClose
}: {
  pagoId: string;
  /** 'staff' muestra el botón de WhatsApp al socio; 'socio' solo imprime/comparte. */
  modo: 'staff' | 'socio';
  onClose: () => void;
}) {
  const [data, setData] = useState<ReciboData | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [telefono, setTelefono] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const t = await backendPost<{ token: string; telefono: string | null }>('recibo-token', { pago_id: pagoId });
        if (cancel) return;
        const r = await backendPost<{ recibo: ReciboData }>('recibo', { id: pagoId, t: t.token });
        if (cancel) return;
        setToken(t.token);
        setTelefono(t.telefono);
        setData(r.recibo);
      } catch (e) {
        if (!cancel) setError(e instanceof Error ? e.message : 'No pudimos generar el recibo.');
      }
    })();
    return () => { cancel = true; };
  }, [pagoId]);

  const url = token ? reciboUrl(window.location.origin, pagoId, token) : null;

  function compartir() {
    if (!url || !data) return;
    if (navigator.share) {
      void navigator.share({ title: `Recibo ${data.folio}`, text: `Tu recibo de ${data.gym.nombre}`, url });
    } else {
      void navigator.clipboard?.writeText(url);
    }
  }

  return (
    <div className="ek-modal-backdrop no-print" onClick={onClose}>
      <div className="ek-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <button
          type="button"
          onClick={onClose}
          className="no-print"
          aria-label="Cerrar"
          style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--sala-text-tertiary)' }}
        >
          <X size={20} />
        </button>

        {error ? (
          <div style={{ padding: '24px 8px', textAlign: 'center' }}>
            <p style={{ margin: 0, color: 'var(--sala-error)', fontWeight: 600 }}>{error}</p>
          </div>
        ) : !data ? (
          <div className="ek-skeleton" style={{ height: 320, borderRadius: 12 }} aria-hidden="true" />
        ) : (
          <>
            <ReciboView data={data} />
            <ReciboPrint data={data} />

            <div className="no-print" style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => window.print()} className="ek-cta" style={{ flex: 1, minWidth: 140, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <Printer size={16} /> Imprimir / PDF
              </button>

              {modo === 'staff' && telefono ? (
                <a
                  href={url ? waReciboUrl(telefono, url, data.gym.nombre) : undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="ek-cta ek-cta--secondary"
                  style={{ flex: 1, minWidth: 140, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, textDecoration: 'none' }}
                >
                  <MessageCircle size={16} /> WhatsApp
                </a>
              ) : (
                <button type="button" onClick={compartir} className="ek-cta ek-cta--secondary" style={{ flex: 1, minWidth: 140, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <Share2 size={16} /> Compartir link
                </button>
              )}
            </div>
            {modo === 'staff' && !telefono && (
              <p className="no-print" style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--sala-text-tertiary)', textAlign: 'center' }}>
                El socio no tiene teléfono guardado — usa “Compartir link”.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}