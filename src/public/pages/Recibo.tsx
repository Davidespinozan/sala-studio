import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Printer, Share2 } from 'lucide-react';
import { backendPost } from '@shared/lib/backend';
import { PoweredBySala } from '@shared/components/PoweredBySala';
import { ReciboView, ReciboPrint } from '@shared/components/ReciboView';
import { type ReciboData, imprimirRecibo, compartirReciboImagen } from '@shared/lib/recibo';

/**
 * PÁGINA PÚBLICA /recibo/:id?t=<token> — a la que llega el socio por el link de
 * WhatsApp (sin sesión). Arma el recibo con la función pública `recibo` y lo deja
 * imprimir / guardar como PDF. Es tenant-agnóstica: todo el contenido (marca del
 * gym incluida) viene en el payload.
 */
export default function Recibo() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const t = params.get('t');

  const [data, setData] = useState<ReciboData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const capturaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      if (!id || !t) { setError('Este link de recibo no es válido.'); return; }
      try {
        const res = await backendPost<{ recibo: ReciboData }>('recibo', { id, t });
        if (!cancel) setData(res.recibo);
      } catch (e) {
        if (!cancel) setError(e instanceof Error ? e.message : 'No pudimos abrir este recibo.');
      }
    })();
    return () => { cancel = true; };
  }, [id, t]);

  async function compartir() {
    if (!data || !capturaRef.current) return;
    setAviso(null);
    try {
      const res = await compartirReciboImagen(capturaRef.current, data);
      if (res === 'descargado') setAviso('Se descargó la imagen del recibo.');
    } catch {
      await navigator.clipboard?.writeText(window.location.href).catch(() => {});
      setAviso('No se pudo generar la imagen. Copiamos el link.');
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 20px', background: 'var(--sala-bg, #f4f4f2)' }}>
      <div style={{ maxWidth: 460, width: '100%' }}>
        {error ? (
          <div className="ek-card" style={{ padding: 28, textAlign: 'center' }}>
            <p style={{ margin: 0, fontWeight: 700 }}>Recibo no disponible</p>
            <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--sala-text-secondary)', lineHeight: 1.5 }}>{error}</p>
          </div>
        ) : !data ? (
          <div className="ek-skeleton" style={{ height: 340, borderRadius: 12 }} aria-hidden="true" />
        ) : (
          <>
            <ReciboView data={data} />
            <ReciboPrint data={data} />
            <div className="no-print" style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <button type="button" onClick={() => imprimirRecibo()} className="ek-cta ek-cta--secondary" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <Printer size={16} /> Imprimir / PDF
              </button>
              <button type="button" onClick={() => void compartir()} className="ek-cta" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <Share2 size={16} /> Compartir
              </button>
            </div>
            {aviso && (
              <p className="no-print" style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--sala-text-secondary)', textAlign: 'center' }}>{aviso}</p>
            )}
            {/* Nodo oculto para capturar la imagen (fuera de pantalla, no display:none). */}
            <div ref={capturaRef} aria-hidden="true" style={{ position: 'fixed', left: -10000, top: 0, width: 460, pointerEvents: 'none', background: '#fff' }}>
              <ReciboView data={data} />
            </div>
            <div className="no-print"><PoweredBySala /></div>
          </>
        )}
      </div>
    </div>
  );
}