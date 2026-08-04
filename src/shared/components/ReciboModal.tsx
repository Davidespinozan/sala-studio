import { useEffect, useRef, useState } from 'react';
import { Printer, Share2, X, Link2 } from 'lucide-react';
import { backendPost } from '@shared/lib/backend';
import { ReciboView, ReciboPrint } from './ReciboView';
import { type ReciboData, reciboUrl, imprimirRecibo, compartirReciboImagen } from '@shared/lib/recibo';

/**
 * Modal in-app que muestra el recibo de un pago y deja:
 *   - Imprimir / guardar PDF (window.print).
 *   - Compartir el recibo como IMAGEN por la hoja del sistema (WhatsApp a
 *     cualquier contacto, sin número prefijado; en desktop descarga la imagen).
 *   - Copiar el link público como respaldo.
 * Pide el token firmado a `recibo-token` y arma el recibo con `recibo` (público),
 * la MISMA fuente que la página pública /recibo — el documento es idéntico.
 */
export function ReciboModal({
  pagoId,
  modo: _modo,
  onClose
}: {
  pagoId: string;
  /** Se conserva por compatibilidad; el flujo de compartir es igual para ambos. */
  modo: 'staff' | 'socio';
  onClose: () => void;
}) {
  const [data, setData] = useState<ReciboData | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [compartiendo, setCompartiendo] = useState(false);
  const capturaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const t = await backendPost<{ token: string; telefono: string | null }>('recibo-token', { pago_id: pagoId });
        if (cancel) return;
        const r = await backendPost<{ recibo: ReciboData }>('recibo', { id: pagoId, t: t.token });
        if (cancel) return;
        setToken(t.token);
        setData(r.recibo);
      } catch (e) {
        if (!cancel) setError(e instanceof Error ? e.message : 'No pudimos generar el recibo.');
      }
    })();
    return () => { cancel = true; };
  }, [pagoId]);

  const url = token ? reciboUrl(window.location.origin, pagoId, token) : null;

  async function compartir() {
    if (!data || !capturaRef.current) return;
    setCompartiendo(true);
    setAviso(null);
    try {
      const res = await compartirReciboImagen(capturaRef.current, data);
      if (res === 'descargado') setAviso('Se descargó la imagen del recibo — adjúntala en WhatsApp.');
    } catch {
      // Si no se pudo generar la imagen, caemos al link.
      if (url && navigator.clipboard) {
        await navigator.clipboard.writeText(url).catch(() => {});
        setAviso('No se pudo generar la imagen. Copiamos el link del recibo.');
      } else {
        setAviso('No se pudo compartir el recibo. Intenta imprimirlo.');
      }
    } finally {
      setCompartiendo(false);
    }
  }

  async function copiarLink() {
    if (!url) return;
    await navigator.clipboard?.writeText(url).catch(() => {});
    setAviso('Link del recibo copiado.');
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
            {/* El recibo VISIBLE es también el que capturamos como imagen: Safari/iOS
                no pinta lo que está fuera de pantalla, así que un clon oculto salía
                en blanco. */}
            <div ref={capturaRef} style={{ background: '#fff' }}>
              <ReciboView data={data} />
            </div>
            <ReciboPrint data={data} />

            <div className="no-print" style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => imprimirRecibo()} className="ek-cta ek-cta--secondary" style={{ flex: 1, minWidth: 140, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <Printer size={16} /> Imprimir / PDF
              </button>
              <button type="button" onClick={() => void compartir()} disabled={compartiendo} className="ek-cta" style={{ flex: 1, minWidth: 140, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <Share2 size={16} /> {compartiendo ? 'Preparando…' : 'Compartir recibo'}
              </button>
            </div>

            <button type="button" onClick={() => void copiarLink()} className="no-print" style={{ marginTop: 10, width: '100%', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--sala-text-tertiary)', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'inherit' }}>
              <Link2 size={14} /> Copiar link del recibo
            </button>

            {aviso && (
              <p className="no-print" style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--sala-text-secondary)', textAlign: 'center', lineHeight: 1.45 }}>
                {aviso}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}