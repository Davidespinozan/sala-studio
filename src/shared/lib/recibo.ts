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
  /** Vencimiento del plan (periodo_actual_fin). Solo en cobros de plan/paquete; null si no aplica. */
  vigenciaFinISO: string | null;
}

const CONCEPTO_LABEL: Record<string, string> = {
  plan: 'Plan',
  paquete: 'Paquete',
  inscripcion: 'Inscripción',
  producto: 'Producto',
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
  const t = (tierNombre ?? '').trim();
  if (!t) return base;
  // Evita "Plan Plan Elevate": si el nombre del plan YA empieza con la palabra
  // base (el gym llamó a su tier "Plan Elevate"), usa solo el nombre del plan.
  if (t.toLowerCase().startsWith(base.toLowerCase())) return t;
  return `${base} ${t}`;
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

/** Fecha de vencimiento del plan en el recibo (sin hora). */
export function venceReciboFmt(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

/** URL pública del recibo (para abrir/compartir/imprimir). */
export function reciboUrl(origin: string, pagoId: string, token: string): string {
  return `${origin}/recibo/${pagoId}?t=${encodeURIComponent(token)}`;
}

/**
 * Imprime SOLO el recibo (portal .recibo-print-root). Marca <body> con
 * `printing-recibo` para que el @media print de sala.css saque del layout todo lo
 * demás (una sola hoja, sin color de fondo de la app).
 *
 * La clase se quita SOLO cuando el diálogo de impresión se cierra (afterprint /
 * focus), NUNCA por timer: en desktop el diálogo sigue abierto un rato y quitarla
 * antes hacía reaparecer la app → páginas en blanco de más. Dejar la clase puesta
 * mientras tanto no afecta la pantalla (las reglas viven dentro de @media print).
 */
function imprimirConClase(clase: string): void {
  const body = document.body;
  body.classList.add(clase);
  const limpiar = () => {
    body.classList.remove(clase);
    window.removeEventListener('afterprint', limpiar);
    window.removeEventListener('focus', limpiar);
  };
  window.addEventListener('afterprint', limpiar, { once: true });
  // Respaldo: al volver el foco a la ventana (se cerró el diálogo), por si el
  // navegador no dispara afterprint. Sin setTimeout, para no limpiar en pleno print.
  window.addEventListener('focus', limpiar, { once: true });
  window.print();
}

export function imprimirRecibo(): void { imprimirConClase('printing-recibo'); }

/** Imprime SOLO el ticket de corte (portal .corte-print-root). */
export function imprimirCorte(): void { imprimirConClase('printing-corte'); }

/** Link de WhatsApp AL SOCIO con su recibo. `telefono` en dígitos (con lada país). */
export function waReciboUrl(telefono: string, url: string, gymNombre: string): string {
  const tel = telefono.replace(/\D/g, '');
  const msg = `Hola, aquí tienes tu recibo de ${gymNombre}: ${url}`;
  return `https://wa.me/${tel}?text=${encodeURIComponent(msg)}`;
}

/**
 * Comparte un NODO como IMAGEN (PNG) por la hoja de compartir del sistema. Así se
 * elige A QUIÉN y POR DÓNDE mandarlo (WhatsApp a cualquier contacto, sin que el
 * número esté guardado, y el contenido se ve dentro del chat). En equipos sin
 * compartir de archivos (típicamente desktop) DESCARGA la imagen para adjuntarla
 * a mano. Debe capturarse un nodo VISIBLE (Safari no pinta nodos fuera de pantalla).
 */
async function compartirNodoImagen(
  node: HTMLElement,
  fileName: string,
  title: string,
  text: string
): Promise<'compartido' | 'descargado'> {
  const { toBlob } = await import('html-to-image');

  // Safari/iOS: la captura sale EN BLANCO si las fuentes/imágenes aún no están
  // listas, y además su primer render suele salir vacío. Por eso: esperamos el
  // decode de las imágenes + las fuentes, y repetimos la conversión (las primeras
  // "calientan" el render; la última es la buena).
  const imgs = Array.from(node.querySelectorAll('img'));
  await Promise.all(imgs.map((img) => (img.decode ? img.decode().catch(() => undefined) : Promise.resolve())));
  try { await document.fonts?.ready; } catch { /* fuentes no disponibles: seguir */ }

  const opts = { pixelRatio: 2, backgroundColor: '#ffffff', cacheBust: true } as const;
  let blob: Blob | null = null;
  for (let i = 0; i < 3; i++) {
    blob = await toBlob(node, opts);
  }
  if (!blob) throw new Error('No se pudo generar la imagen.');
  const file = new File([blob], fileName, { type: 'image/png' });

  const nav = navigator as Navigator & {
    canShare?: (d: { files?: File[] }) => boolean;
    share?: (d: { files?: File[]; title?: string; text?: string }) => Promise<void>;
  };
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    await nav.share({ files: [file], title, text });
    return 'compartido';
  }

  // Fallback (sin compartir de archivos): descarga la imagen para adjuntarla a mano.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return 'descargado';
}

/** Comparte el RECIBO como imagen. `node`: un ReciboView renderizado a capturar. */
export async function compartirReciboImagen(
  node: HTMLElement,
  data: ReciboData
): Promise<'compartido' | 'descargado'> {
  return compartirNodoImagen(node, `recibo-${data.folio}.png`, `Recibo ${data.folio}`, `Recibo de ${data.gym.nombre}`);
}

/**
 * Comparte el TICKET DE CORTE como imagen. `node`: un CorteTicket renderizado y
 * VISIBLE (el del modal). `gymNombre`/`hastaISO` solo para el nombre del archivo
 * y el texto que acompaña.
 */
export async function compartirCorteImagen(
  node: HTMLElement,
  gymNombre: string,
  hastaISO: string
): Promise<'compartido' | 'descargado'> {
  const d = new Date(hastaISO);
  const slug = Number.isNaN(d.getTime()) ? 'corte' : d.toISOString().slice(0, 10);
  return compartirNodoImagen(node, `corte-caja-${slug}.png`, 'Corte de caja', `Corte de caja de ${gymNombre}`);
}