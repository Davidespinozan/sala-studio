/**
 * RECIBO (comprobante interno, NO es CFDI/factura fiscal) de un cobro del ledger
 * `pagos`. La función pública netlify/functions/recibo arma un ReciboData a partir
 * del id + token; la app (socio/staff) y la página pública /recibo lo renderizan
 * con el MISMO componente (ReciboView), así el recibo es idéntico en todos lados.
 */

export interface ReciboData {
  /** Folio legible y estable, derivado del id del pago. */
  folio: string;
  fechaISO: string;
  gym: {
    nombre: string;
    logoUrl: string | null;
    direccion: string | null;
    /** WhatsApp/teléfono del gym (para el pie del recibo). */
    telefono: string | null;
  };
  socio: string;
  /** Enum crudo de `pagos.concepto` (plan|inscripcion|paquete|reembolso|otro). */
  concepto: string;
  tierNombre: string | null;
  /** Enum crudo de `pagos.metodo`. */
  metodo: string;
  montoCentavos: number;
  moneda: string;
}

const CONCEPTO_LABEL: Record<string, string> = {
  plan: 'Plan',
  paquete: 'Paquete',
  inscripcion: 'Inscripción',
  reembolso: 'Reembolso',
  otro: 'Pago'
};

const METODO_LABEL: Record<string, string> = {
  efectivo: 'Efectivo',
  tarjeta: 'Terminal (tarjeta)',
  transferencia: 'Transferencia',
  stripe: 'Pago en línea',
  cortesia: 'Cortesía'
};

export function conceptoLabel(concepto: string, tierNombre?: string | null): string {
  const base = CONCEPTO_LABEL[concepto] ?? 'Pago';
  return tierNombre ? `${base} ${tierNombre}` : base;
}

export function metodoLabel(metodo: string): string {
  return METODO_LABEL[metodo] ?? metodo;
}

/** No hay columna de folio: lo derivamos del id (estable y único por pago). */
export function folioDePago(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

export function montoFmt(centavos: number, moneda = 'MXN'): string {
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: (moneda || 'MXN').toUpperCase(),
      maximumFractionDigits: 2
    }).format(centavos / 100);
  } catch {
    return `$${(centavos / 100).toLocaleString('es-MX')}`;
  }
}

export function fechaReciboFmt(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

/** URL pública del recibo (para abrir/compartir/imprimir). */
export function reciboUrl(origin: string, pagoId: string, token: string): string {
  return `${origin}/recibo/${pagoId}?t=${encodeURIComponent(token)}`;
}

/**
 * Imprime SOLO el recibo (portal .recibo-print-root). Marca <body> con
 * `printing-recibo` para que el @media print de sala.css saque del layout todo lo
 * demás (una sola hoja, sin color de fondo de la app) y lo quita al terminar.
 */
export function imprimirRecibo(): void {
  const body = document.body;
  body.classList.add('printing-recibo');
  const limpiar = () => body.classList.remove('printing-recibo');
  window.addEventListener('afterprint', limpiar, { once: true });
  // Fallback: algunos navegadores no disparan afterprint (o el usuario cancela).
  window.setTimeout(limpiar, 1500);
  window.print();
}

/** Link de WhatsApp AL SOCIO con su recibo. `telefono` en dígitos (con lada país). */
export function waReciboUrl(telefono: string, url: string, gymNombre: string): string {
  const tel = telefono.replace(/\D/g, '');
  const msg = `Hola, aquí tienes tu recibo de ${gymNombre}: ${url}`;
  return `https://wa.me/${tel}?text=${encodeURIComponent(msg)}`;
}