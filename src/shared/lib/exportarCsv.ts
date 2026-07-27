// ============================================================================
// EXPORTAR A CSV — descarga un CSV desde el navegador (sin servidor).
// ----------------------------------------------------------------------------
// Portabilidad + contador + respaldo: el gym se lleva sus datos cuando quiera.
// Escapa comillas/comas/saltos y antepone BOM para que Excel respete los acentos.
// ============================================================================

export interface ColumnaCsv<T> {
  key: keyof T | string;
  label: string;
  /** Formateo opcional del valor (fecha, dinero, etc.). */
  valor?: (fila: T) => unknown;
}

function celda(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/** Construye el texto CSV (con BOM). Puro y testeable; sin DOM. */
export function construirCsv<T extends object>(
  filas: T[],
  columnas?: ColumnaCsv<T>[]
): string {
  if (filas.length === 0) return '';
  const cols: ColumnaCsv<T>[] =
    columnas ?? Object.keys(filas[0]).map((k) => ({ key: k, label: k }));

  const head = cols.map((c) => celda(c.label)).join(',');
  const body = filas
    .map((f) => cols.map((c) => celda(c.valor ? c.valor(f) : (f as Record<string, unknown>)[c.key as string])).join(','))
    .join('\r\n');

  // ﻿ (BOM) → Excel abre en UTF-8 y no rompe los acentos.
  return '﻿' + head + '\r\n' + body;
}

/** Descarga `filas` como CSV. Con `columnas` controlás orden/encabezados; sin
 *  ellas, usa las llaves de la primera fila. */
export function exportarCsv<T extends object>(
  nombreArchivo: string,
  filas: T[],
  columnas?: ColumnaCsv<T>[]
): void {
  if (filas.length === 0) return;
  const csv = construirCsv(filas, columnas);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombreArchivo.endsWith('.csv') ? nombreArchivo : `${nombreArchivo}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
