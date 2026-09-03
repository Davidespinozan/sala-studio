import { createPortal } from 'react-dom';
import {
  type ReciboData,
  conceptoLabel,
  metodoLabel,
  montoFmt,
  fechaReciboFmt,
  venceReciboFmt
} from '@shared/lib/recibo';

/**
 * Recibo imprimible (comprobante interno, no CFDI). Documento en blanco/negro,
 * pensado para verse bien impreso o guardado como PDF desde el navegador.
 * Se usa igual en la app (dentro de ReciboModal) y en la página pública /recibo.
 */
export function ReciboView({ data }: { data: ReciboData }) {
  const esReembolso = data.concepto === 'reembolso';
  const ink = '#1a1f1c';
  const muted = '#767b77';
  const line = '#e6e6e3';
  return (
    <div
      style={{
        background: '#ffffff',
        color: ink,
        border: '1px solid #e4e4e4',
        borderRadius: 12,
        padding: '34px 32px',
        maxWidth: 460,
        width: '100%',
        margin: '0 auto',
        fontFamily: 'var(--ek-font-sans, system-ui, sans-serif)'
      }}
    >
      {/* Encabezado del gym, centrado */}
      <div style={{ textAlign: 'center', paddingBottom: 20, borderBottom: `1px solid ${line}` }}>
        {data.gym.logoUrl ? (
          <img
            src={data.gym.logoUrl}
            alt={data.gym.nombre}
            crossOrigin="anonymous"
            style={{ height: 48, maxWidth: 180, objectFit: 'contain', margin: '0 auto 6px' }}
          />
        ) : (
          <p style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>{data.gym.nombre}</p>
        )}
        {data.gym.logoUrl && (
          <p style={{ margin: '2px 0 0', fontSize: 13, fontWeight: 700 }}>{data.gym.nombre}</p>
        )}
        {data.gym.direccion && (
          <p style={{ margin: '4px 0 0', fontSize: 11.5, color: muted, lineHeight: 1.5 }}>{data.gym.direccion}</p>
        )}
      </div>

      {/* Título del documento */}
      <p style={{ margin: '20px 0 0', textAlign: 'center', fontSize: 12, fontWeight: 700, letterSpacing: '0.22em', color: muted }}>
        {esReembolso ? 'COMPROBANTE DE REEMBOLSO' : 'RECIBO DE PAGO'}
      </p>

      {/* Meta: folio + fecha */}
      <div style={{ margin: '16px 0 4px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Fila k="Folio" v={data.folio} mono />
        <Fila k="Fecha" v={fechaReciboFmt(data.fechaISO)} />
        <Fila k="Socio" v={data.socio} />
        <Fila k="Concepto" v={conceptoLabel(data.concepto, data.tierNombre)} />
        <Fila k="Método de pago" v={metodoLabel(data.metodo)} />
        {!esReembolso && data.vigenciaFinISO && (
          <Fila k="Tu plan vence" v={venceReciboFmt(data.vigenciaFinISO)} />
        )}
      </div>

      {/* Total */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          marginTop: 18,
          padding: '16px 0 0',
          borderTop: `2px solid ${ink}`
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: '0.06em', color: muted }}>
          {esReembolso ? 'DEVUELTO' : 'TOTAL PAGADO'}
        </span>
        <span style={{ fontSize: 25, fontWeight: 800, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
          {esReembolso ? '−' : ''}{montoFmt(Math.abs(data.montoCentavos), data.moneda)} {data.moneda.toUpperCase()}
        </span>
      </div>

      {/* Pie */}
      <p style={{ margin: '24px 0 0', fontSize: 10.5, color: '#9a9f9b', lineHeight: 1.55, textAlign: 'center' }}>
        Comprobante interno de {data.gym.nombre} · No es un comprobante fiscal (CFDI)
        {data.gym.telefono ? <><br />{data.gym.telefono}</> : null}
      </p>
    </div>
  );
}

/**
 * Copia del recibo montada como portal DIRECTO en <body>, fuera del modal. En
 * pantalla está oculta (display:none vía .recibo-print-root); solo aparece en
 * @media print. Así se imprime el recibo completo sin que el overflow/position
 * del modal lo recorte. Móntala junto al ReciboView visible.
 */
export function ReciboPrint({ data }: { data: ReciboData }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="recibo-print-root">
      <ReciboView data={data} />
    </div>,
    document.body
  );
}

function Fila({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 13.5 }}>
      <span style={{ color: '#767b77' }}>{k}</span>
      <span
        style={{
          fontWeight: 600,
          textAlign: 'right',
          color: '#1a1f1c',
          fontFamily: mono ? 'var(--ek-font-mono, ui-monospace, monospace)' : undefined,
          letterSpacing: mono ? '0.04em' : undefined
        }}
      >
        {v}
      </span>
    </div>
  );
}