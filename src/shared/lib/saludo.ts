import { Sun, CloudSun, Moon, type LucideIcon } from 'lucide-react';
import { formatInTimeZone } from 'date-fns-tz';

/**
 * "Buenos días / Buenas tardes / Buenas noches" según la hora del GYM (tz), no
 * la del navegador: si el dueño revisa desde otra zona, el saludo sigue al gym.
 */
export function saludoPorHora(tz: string, d: Date = new Date()): { texto: string; Icon: LucideIcon } {
  const h = Number(formatInTimeZone(d, tz, 'H'));
  if (h >= 5 && h < 12) return { texto: 'Buenos días', Icon: Sun };
  if (h >= 12 && h < 19) return { texto: 'Buenas tardes', Icon: CloudSun };
  return { texto: 'Buenas noches', Icon: Moon };
}

/** Nombre de pila capitalizado ('ALEJANDRA rendón' → 'Alejandra'). */
export function nombreDePila(nombre: string | null | undefined): string {
  const primero = (nombre ?? '').trim().split(/\s+/)[0] ?? '';
  return primero ? primero.charAt(0).toUpperCase() + primero.slice(1).toLowerCase() : '';
}

/** Etiqueta humana del rol de staff. */
export function etiquetaRol(rol: string | null | undefined): string | null {
  if (rol === 'admin') return 'Administrador';
  if (rol === 'recepcionista') return 'Recepción';
  if (rol === 'staff') return 'Staff';
  return null;
}
