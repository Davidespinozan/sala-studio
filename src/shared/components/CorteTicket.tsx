import { createPortal } from 'react-dom';
import { centavosEnLetras } from '@shared/lib/enLetras';

export interface CorteTicketData {
  gym: { nombre: string; direccion: string | null; rfc: string | null; telefono: string | null };
  sucursalNombre: string | null;
  recepcion: string | null;
  desde: string | null;
  hasta: string;
  porConcepto: { label: string; centavos: number }[];
  totalCentavos: number;
  porMetodo: { label: string; centavos: number }[];
  moneda: string;
  // Cuadre de efectivo (la mejora frente al sistema viejo).
  efectivoEsperadoCentavos?: number | null;
  fondoCentavos?: number | null;
  efectivoContadoCentavos?: number | null;
  diferenciaCentavos?: number | null;
}

function money(centavos: number, moneda = 'MXN'): string {
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: (moneda || 'MXN').toUpperCase(), minimumFractionDigits: 2 }).format(centavos / 100);
  } catch {
    return `$${(centavos / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
  }
}
function fechaLarga(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const ink = '#1a1f1c';
const muted = '#6b706c';
const line = '#d9d9d6';

/**
 * Ticket de CORTE DE CAJA imprimible (comprobante interno). Resumen de ventas del
 * periodo por concepto y por método, total en letra, encabezado con datos del gym,
 * y el cuadre de efectivo (contado vs esperado). Se ve igual en pantalla y en papel.
 */
export function CorteTicket({ data }: { data: CorteTicketData }) {
  const conCuadre = data.efectivoContadoCentavos != null;
  const dif = data.diferenciaCentavos ?? 0;
  return (
    <div style={{ background: '#fff', color: ink, maxWidth: 420, width: '100%', margin: '0 auto', padding: '28px 26px', fontFamily: 'var(--ek-font-sans, system-ui, sans-serif)', fontSize: 13 }}>
      {/* Encabezado */}
      <div style={{ textAlign: 'center', lineHeight: 1.5 }}>
        <p style={{ margin: 0, fontSize: 19, fontWeight: 800, letterSpacing: '0.02em' }}>{data.gym.nombre}</p>
        {data.gym.direccion && <p style={{ margin: '2px 0 0', fontSize: 11.5, color: muted }}>{data.gym.direccion}</p>}
        {data.gym.rfc && <p style={{ margin: '2px 0 0', fontSize: 11.5, color: muted }}>RFC: {data.gym.rfc}</p>}
        {data.gym.telefono && <p style={{ margin: '2px 0 0', fontSize: 11.5, color: muted }}>Tel: {data.gym.telefono}</p>}
      </div>

      <Sep />

      <div style={{ textAlign: 'center', lineHeight: 1.5, fontSize: 12 }}>
        {data.desde && <p style={{ margin: 0 }}>Del: {fechaLarga(data.desde)}</p>}
        <p style={{ margin: 0 }}>Al: {fechaLarga(data.hasta)}</p>
      </div>

      <Sep />
      <p style={{ textAlign: 'center', fontWeight: 800, letterSpacing: '0.18em', margin: 0, fontSize: 15 }}>CORTE DE CAJA</p>
      <Sep />

      {data.recepcion && (
        <p style={{ margin: '0 0 10px', fontSize: 12 }}><strong>Recepción:</strong> {data.recepcion}{data.sucursalNombre ? ` · ${data.sucursalNombre}` : ''}</p>
      )}

      {/* Ventas por concepto */}
      <p style={{ margin: '0 0 6px', fontWeight: 700 }}>Venta total: {money(data.totalCentavos, data.moneda)}</p>
      {data.porConcepto.map((c) => (
        <Linea key={c.label} k={c.label} v={money(c.centavos, data.moneda)} />
      ))}

      <Sep />
      <div style={{ textAlign: 'center' }}>
        <p style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>Total: {money(data.totalCentavos, data.moneda)}</p>
        <p style={{ margin: '4px 0 0', fontSize: 11.5, color: muted }}>Son: {centavosEnLetras(data.totalCentavos)}</p>
      </div>

      {/* Por método */}
      {data.porMetodo.length > 0 && (
        <>
          <p style={{ margin: '14px 0 6px', fontSize: 11.5, color: muted, textAlign: 'center' }}>De los cuales:</p>
          {data.porMetodo.map((m) => (
            <Linea key={m.label} k={m.label} v={money(m.centavos, data.moneda)} />
          ))}
        </>
      )}

      {/* Cuadre de efectivo (mejora) */}
      {conCuadre && (
        <>
          <Sep />
          <p style={{ textAlign: 'center', fontWeight: 700, margin: '0 0 8px', fontSize: 12.5 }}>Cuadre de efectivo</p>
          {data.fondoCentavos ? <Linea k="Fondo inicial" v={money(data.fondoCentavos, data.moneda)} /> : null}
          <Linea k="Efectivo esperado" v={money((data.efectivoEsperadoCentavos ?? 0) + (data.fondoCentavos ?? 0), data.moneda)} />
          <Linea k="Efectivo contado" v={money(data.efectivoContadoCentavos ?? 0, data.moneda)} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontWeight: 800, color: dif === 0 ? ink : dif > 0 ? '#1e7a46' : '#b3261e' }}>
            <span>{dif === 0 ? 'Cuadra' : dif > 0 ? 'Sobrante' : 'Faltante'}</span>
            <span>{dif === 0 ? money(0, data.moneda) : money(Math.abs(dif), data.moneda)}</span>
          </div>
        </>
      )}

      <Sep />
      <p style={{ textAlign: 'center', fontSize: 10.5, color: '#9a9f9b', lineHeight: 1.5, margin: 0 }}>
        {data.gym.nombre}{data.sucursalNombre ? ` · Suc: ${data.sucursalNombre}` : ''}<br />
        Comprobante interno · No es un comprobante fiscal (CFDI)
      </p>
    </div>
  );
}

function Sep() {
  return <div style={{ borderTop: `1px dashed ${line}`, margin: '12px 0' }} />;
}
function Linea({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5, padding: '2px 0' }}>
      <span style={{ color: muted }}>{k}</span>
      <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
    </div>
  );
}

/** Copia del ticket montada como portal en <body>, visible solo al imprimir. */
export function CortePrint({ data }: { data: CorteTicketData }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="corte-print-root">
      <CorteTicket data={data} />
    </div>,
    document.body
  );
}