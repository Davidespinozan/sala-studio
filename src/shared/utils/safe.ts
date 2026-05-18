/** Saneo de inputs (heredado del patrón Cubo Polar utils/safe.js). */

export const s = (v: unknown): string => (v == null ? '' : String(v));

export const n = (v: unknown, fallback = 0): number => {
  const x = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(x) ? x : fallback;
};

export const money = (cents: number): string => {
  const value = cents / 100;
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2
  }).format(value);
};

export const todayISO = (): string => new Date().toISOString().slice(0, 10);

export const todayLocalISO = (): string => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const eqId = (a: unknown, b: unknown): boolean => String(a ?? '') === String(b ?? '');

export const arr = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);
