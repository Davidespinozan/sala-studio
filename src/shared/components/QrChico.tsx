import { useEffect, useRef } from 'react';
import QRCodeStyling from 'qr-code-styling';

/** QR chiquito que abre una URL (ej. la de activar/login del gym). */
export function QrChico({ data, size = 92 }: { data: string; size?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const qr = new QRCodeStyling({
      width: size, height: size, type: 'svg', data, margin: 4,
      dotsOptions: { color: '#0A0A0A', type: 'square' },
      backgroundOptions: { color: '#FFFFFF' },
      qrOptions: { errorCorrectionLevel: 'M' }
    });
    ref.current.innerHTML = '';
    qr.append(ref.current);
  }, [data, size]);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{ flexShrink: 0, width: size, height: size, borderRadius: 8, overflow: 'hidden', background: '#fff' }}
    />
  );
}