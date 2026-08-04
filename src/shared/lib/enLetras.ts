/** Monto (centavos) a letra para el corte: "Dieciocho mil novecientos con 00/100 M.N". */

const UNIDADES = [
  '', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho',
  'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro',
  'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'
];
const DECENAS = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function seccion(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  let s = '';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  if (c) s += CENTENAS[c] + (resto ? ' ' : '');
  if (resto < 30) {
    s += UNIDADES[resto];
  } else {
    const d = Math.floor(resto / 10);
    const u = resto % 10;
    s += DECENAS[d] + (u ? ' y ' + UNIDADES[u] : '');
  }
  return s.trim();
}

/** Ajusta "uno"/"veintiuno" → "un"/"veintiún" antes de mil/millón. */
function apocope(s: string): string {
  return s.replace(/veintiuno$/, 'veintiún').replace(/(\b|\s)uno$/, '$1un');
}

function enteroALetras(n: number): string {
  if (n === 0) return 'cero';
  let s = '';
  const millones = Math.floor(n / 1_000_000);
  const miles = Math.floor((n % 1_000_000) / 1000);
  const cientos = n % 1000;
  if (millones) s += (millones === 1 ? 'un millón' : apocope(enteroALetras(millones)) + ' millones') + ' ';
  if (miles) s += (miles === 1 ? 'mil' : apocope(seccion(miles)) + ' mil') + ' ';
  if (cientos) s += seccion(cientos);
  return s.trim().replace(/\s+/g, ' ');
}

export function centavosEnLetras(centavos: number, moneda = 'M.N'): string {
  const neg = centavos < 0;
  const abs = Math.abs(centavos);
  const pesos = Math.floor(abs / 100);
  const cent = abs % 100;
  let s = enteroALetras(pesos);
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return `${neg ? 'Menos ' : ''}${s} con ${String(cent).padStart(2, '0')}/100 ${moneda}`;
}