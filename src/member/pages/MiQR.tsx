import { useEffect, useState, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useParams, Link } from 'react-router-dom';
import QRCodeStyling from 'qr-code-styling';
import { supabase } from '@shared/lib/supabase';
import { backendPost } from '@shared/lib/backend';
import { useTenant } from '@shared/hooks/useTenant';
import { getTenantTimezone, formatHoraEnTz } from '@shared/lib/timezone';

interface IssueResponse {
  qr_payload: string;
  expires_at: string;
}

/** Traduce el error del backend a copy claro para el socio (nunca el mensaje crudo). */
function traducirErrorQR(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes('cancelada')) return 'Esta reserva está cancelada.';
  if (m.includes('no encontrada') || m.includes('no autorizada')) return 'No encontramos esta reserva.';
  return 'No pudimos generar tu código. Probá de nuevo en un momento.';
}

export default function MiQR() {
  const { reservaId } = useParams<{ reservaId: string }>();
  const tenant = useTenant();
  const tz = getTenantTimezone(tenant);
  const qrContainerRef = useRef<HTMLDivElement>(null);
  const qrInstance = useRef<QRCodeStyling | null>(null);

  const [reserva, setReserva] = useState<any>(null);
  const [qrPayload, setQrPayload] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0); // bump → reintenta

  // Cargar datos de la reserva y emitir QR
  useEffect(() => {
    if (!reservaId) return;
    let mounted = true;

    async function load() {
      const { data: r } = await supabase
        .from('reservas')
        .select('*, recurso:recursos(id, slug, nombre)')
        .eq('id', reservaId!)
        .maybeSingle();

      if (!mounted) return;
      if (!r) {
        setError('No encontramos esta reserva.');
        setIsLoading(false);
        return;
      }
      setReserva(r);

      try {
        const res = await backendPost<IssueResponse>('qr-issue', { reserva_id: reservaId });
        if (!mounted) return;
        setQrPayload(res.qr_payload);
        setExpiresAt(new Date(res.expires_at));
        setIsLoading(false);
      } catch (e) {
        if (!mounted) return;
        console.error('[MiQR] qr-issue falló:', e);
        setError(traducirErrorQR(e instanceof Error ? e.message : ''));
        setIsLoading(false);
      }
    }

    load();
    return () => { mounted = false; };
  }, [reservaId, nonce]);

  // Renderizar QR con qr-code-styling
  useEffect(() => {
    if (!qrPayload || !qrContainerRef.current) return;

    qrInstance.current = new QRCodeStyling({
      width: 320,
      height: 320,
      type: 'svg',
      data: qrPayload,
      margin: 16,
      dotsOptions: { color: '#0A0A0A', type: 'square' },
      backgroundOptions: { color: '#FFFFFF' },
      cornersSquareOptions: { color: '#0A0A0A', type: 'square' },
      cornersDotOptions: { color: '#0A0A0A', type: 'square' },
      qrOptions: { errorCorrectionLevel: 'M' }
    });

    qrContainerRef.current.innerHTML = '';
    qrInstance.current.append(qrContainerRef.current);
  }, [qrPayload]);

  if (isLoading) return <div className="ek-container"><p className="ek-body">Generando QR…</p></div>;

  if (error) {
    const esCancelada = error.toLowerCase().includes('cancelada');
    return (
      <div className="ek-container">
        <Link to="/app/historial" className="adm-link" style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}><ArrowLeft size={15} strokeWidth={2.25} />Volver</Link>
        <p className="ek-error-text" style={{ marginTop: '1rem' }}>{error}</p>
        {!esCancelada && (
          <button
            type="button"
            onClick={() => { setError(null); setIsLoading(true); setNonce((n) => n + 1); }}
            className="ek-cta ek-cta--secondary"
            style={{ marginTop: '0.75rem' }}
          >
            Reintentar
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <Link to="/app/historial" className="adm-link" style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}><ArrowLeft size={15} strokeWidth={2.25} />Volver al historial</Link>

        <div className="ek-stack-md">
          <p
            style={{
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--sala-accent)',
              margin: 0
            }}
          >
            Tu QR de acceso
          </p>
          <h1
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: 'clamp(26px, 6vw, 32px)',
              fontWeight: 700,
              letterSpacing: '-0.03em',
              lineHeight: 1.05,
              color: 'var(--sala-text-primary)',
              margin: 0
            }}
          >
            {reserva?.recurso?.nombre ?? 'Sala'}
          </h1>
          <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', margin: 0, lineHeight: 1.45 }}>
            {new Date(reserva.slot_inicio).toLocaleDateString('es-MX', {
              weekday: 'long', day: 'numeric', month: 'long', timeZone: tz
            })}
            <br />
            {formatHoraEnTz(new Date(reserva.slot_inicio), tz)} – {formatHoraEnTz(new Date(reserva.slot_fin), tz)}
          </p>
        </div>

        {/* Contenedor blanco DELIBERADO: el scanner necesita contraste
            negro-sobre-blanco para decodificar de forma confiable.
            No cambiar a fondo oscuro. */}
        <div
          style={{
            background: '#FFFFFF',
            borderRadius: 'var(--ek-r-card)',
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '16px'
          }}
        >
          <div ref={qrContainerRef} className="qr-box" />
          <p style={{ fontFamily: 'var(--ek-font-mono)', fontSize: '13px', color: '#0A0A0A' }}>
            {reserva?.folio}
          </p>
        </div>

        <div className="ek-card">
          <p className="ek-eyebrow" style={{ marginBottom: '8px' }}>INSTRUCCIONES</p>
          <p className="ek-body-muted">
            Muestra este código al llegar a {tenant.nombre}. La recepción lo escanea
            para confirmar tu entrada.
            {expiresAt && (
              <>
                <br /><br />
                Válido hasta las {formatHoraEnTz(expiresAt, tz)} del día de tu clase.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
