import {
  type ReciboData,
  conceptoLabel,
  metodoLabel,
  montoFmt,
  fechaReciboFmt
} from '@shared/lib/recibo';

/**
 * Recibo imprimible (comprobante interno, no CFDI). Documento en blanco/negro,
 * pensado para verse bien impreso o guardado como PDF desde el navegador.
 * Se usa igual en la app (dentro de ReciboModal) y en la página pública /recibo.
 *
 * La clase `recibo-print` la usa el @media print de sala.css para imprimir SOLO
 * el recibo, ocultando el resto de la app.
 */
export function ReciboView({ data }: { data: ReciboData }) {
  const esReembolso = data.concepto === 'reembolso';
  return (
    <div
      className="recibo-print"
      style={{
        background: '#ffffff',
        color: '#1a1f1c',
        border: '1px solid #e4e4e4',
        borderRadius: 12,
        padding: '28px 26px',
        maxWidth: 440,
        width: '100%',
        margin: '0 auto',
        fontFamily: 'var(--ek-font-sans, system-ui, sans-serif)'
      }}
    >
      {/* Encabezado: gym */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingBottom: 18, borderBottom: '1px solid #ececec' }}>
        {data.gym.logoUrl ? (
          <img
            src={data.gym.logoUrl}
            alt={data.gym.nombre}
            style={{ height: 44, maxWidth: 130, objectFit: 'contain' }}
          />
        ) : (
          <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em' }}>{data.gym.nombre}</span>
        )}
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <p style={{ margin: 0, fontSize: 11, letterSpacing: '0.12em', color: '#8a8f8b', fontWeight: 700 }}>
            {esReembolso ? 'COMPROBANTE DE REEMBOLSO' : 'RECIBO DE PAGO'}
          </p>
          <p style={{ margin: '2px 0 0', fontSize: 13, fontWeight: 700 }}>Folio {data.folio}</p>
        </div>
      </div>

      {/* Datos del gym (nombre + dirección) cuando hay logo, si no ya salió el nombre */}
      {(data.gym.logoUrl || data.gym.direccion) && (
        <p style={{ margin: '12px 0 0', fontSize: 12, color: '#6b706c', lineHeight: 1.5 }}>
          {data.gym.logoUrl ? <strong style={{ color: '#1a1f1c' }}>{data.gym.nombre}</strong> : null}
          {data.gym.logoUrl && data.gym.direccion ? ' · ' : ''}
          {data.gym.direccion}
        </p>
      )}

      {/* Cuerpo */}
      <div style={{ margin: '20px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Fila k="Fecha" v={fechaReciboFmt(data.fechaISO)} />
        <Fila k="Socio" v={data.socio} />
        <Fila k="Concepto" v={conceptoLabel(data.concepto, data.tierNombre)} />
        <Fila k="Método de pago" v={metodoLabel(data.metodo)} />
      </div>

      {/* Total */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          padding: '16px 0',
          borderTop: '2px solid #1a1f1c'
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.02em' }}>
          {esReembolso ? 'DEVUELTO' : 'TOTAL PAGADO'}
        </span>
        <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em' }}>
          {esReembolso ? '−' : ''}{montoFmt(Math.abs(data.montoCentavos), data.moneda)} {data.moneda.toUpperCase()}
        </span>
      </div>

      {/* Pie */}
      <p style={{ margin: '18px 0 0', fontSize: 10.5, color: '#9a9f9b', lineHeight: 1.55, textAlign: 'center' }}>
        Comprobante interno de {data.gym.nombre}. No es un comprobante fiscal (CFDI).
        {data.gym.telefono ? <> · {data.gym.telefono}</> : null}
      </p>
    </div>
  );
}

function Fila({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 13.5 }}>
      <span style={{ color: '#8a8f8b' }}>{k}</span>
      <span style={{ fontWeight: 600, textAlign: 'right', color: '#1a1f1c' }}>{v}</span>
    </div>
  );
}