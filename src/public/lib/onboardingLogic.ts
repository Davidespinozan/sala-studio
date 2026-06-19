// ════════════════════════════════════════════════════════════════════════════
// S9 — Lógica pura del onboarding self-service
// ════════════════════════════════════════════════════════════════════════════
// Validaciones de cada paso, normalización de subdominio y armado del payload
// que se manda a la Netlify Function. Sin React, sin red → 100% testeable.
// ════════════════════════════════════════════════════════════════════════════

import {
  precioCentavos,
  monedaPorTimezone,
  type TierSaas,
  type MonedaSaas
} from '@shared/lib/planesSaas';

export const SLUG_MIN = 3;
export const SLUG_MAX = 30;
export const PASSWORD_MIN = 8;

/** Color primario por defecto (Salvia). */
export const COLOR_PRIMARIO_DEFAULT = '#3d6b52';

/** Color de acento por defecto. Igual al primario → marca monocroma segura
 *  hasta que el dueño elija un acento distinto en el wizard. */
export const COLOR_ACENTO_DEFAULT = '#3d6b52';

/** Subdominios que no se pueden usar (técnicos / reservados de la plataforma). */
export const SUBDOMINIOS_RESERVADOS = new Set<string>([
  'admin', 'www', 'app', 'api', 'mail', 'ftp', 'blog', 'dev', 'staging',
  'test', 'demo', 'sala', 'sala-demo', 'healthyspace', 'static', 'assets', 'cdn', 'docs',
  'help', 'support', 'status', 'login', 'signup', 'registro', 'onboarding',
  'dashboard', 'recepcion', 'public', 'cuenta', 'billing'
]);

export interface ResultadoValidacion {
  ok: boolean;
  error?: string;
}

const OK: ResultadoValidacion = { ok: true };

// ── Datos del wizard ────────────────────────────────────────────────────────

export interface DatosCuenta {
  nombre: string;
  email: string;
  password: string;
}

export interface DatosGym {
  gymNombre: string;
  slug: string;
  timezone: string;
}

export interface DatosSetup {
  colorPrimario: string;
  colorAcento: string;
  logoUrl: string | null;
  salaNombre: string;
  salaCupo: number;
}

export interface OnboardingState {
  cuenta: DatosCuenta;
  gym: DatosGym;
  tier: TierSaas | null;
  setup: DatosSetup;
}

// ── Validaciones de campo ───────────────────────────────────────────────────

/**
 * Valida el formato de un subdominio: 3–30 caracteres, solo minúsculas,
 * números y guiones; sin guión al inicio/fin ni guiones dobles; no reservado.
 * La unicidad real la garantiza el constraint UNIQUE de la BD.
 */
export function validarSubdominio(slug: string): ResultadoValidacion {
  const s = slug.trim().toLowerCase();
  if (!s) return { ok: false, error: 'Elige un subdominio.' };
  if (s.length < SLUG_MIN) return { ok: false, error: `Mínimo ${SLUG_MIN} caracteres.` };
  if (s.length > SLUG_MAX) return { ok: false, error: `Máximo ${SLUG_MAX} caracteres.` };
  if (!/^[a-z0-9-]+$/.test(s)) {
    return { ok: false, error: 'Solo minúsculas, números y guiones.' };
  }
  if (s.startsWith('-') || s.endsWith('-')) {
    return { ok: false, error: 'No puede empezar ni terminar con guión.' };
  }
  if (s.includes('--')) return { ok: false, error: 'No uses guiones seguidos.' };
  if (SUBDOMINIOS_RESERVADOS.has(s)) {
    return { ok: false, error: 'Ese subdominio está reservado. Elige otro.' };
  }
  return OK;
}

/** Normaliza un texto libre a un subdominio candidato (para autosugerir). */
export function sugerirSubdominio(nombre: string): string {
  return nombre
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // quita acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

export function validarEmail(email: string): ResultadoValidacion {
  const e = email.trim();
  if (!e) return { ok: false, error: 'Ingresa tu email.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    return { ok: false, error: 'El email no es válido.' };
  }
  return OK;
}

/** Password fuerte: mínimo 8 caracteres, con al menos una letra y un número. */
export function validarPassword(password: string): ResultadoValidacion {
  if (password.length < PASSWORD_MIN) {
    return { ok: false, error: `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres.` };
  }
  if (!/[a-zA-Z]/.test(password)) {
    return { ok: false, error: 'La contraseña debe incluir al menos una letra.' };
  }
  if (!/[0-9]/.test(password)) {
    return { ok: false, error: 'La contraseña debe incluir al menos un número.' };
  }
  return OK;
}

// ── Validación por paso del wizard ──────────────────────────────────────────

/** Paso 1 — Cuenta. */
export function validarPasoCuenta(d: DatosCuenta): ResultadoValidacion {
  if (!d.nombre.trim()) return { ok: false, error: 'Ingresa tu nombre.' };
  const email = validarEmail(d.email);
  if (!email.ok) return email;
  return validarPassword(d.password);
}

/** Paso 2 — Datos del gym. */
export function validarPasoGym(d: DatosGym): ResultadoValidacion {
  if (!d.gymNombre.trim()) return { ok: false, error: 'Ingresa el nombre del gym.' };
  const slug = validarSubdominio(d.slug);
  if (!slug.ok) return slug;
  if (!d.timezone.trim()) return { ok: false, error: 'Elige tu país / zona horaria.' };
  return OK;
}

/** Paso 3 — Plan. */
export function validarPasoPlan(tier: TierSaas | null): ResultadoValidacion {
  if (!tier) return { ok: false, error: 'Elige un plan para continuar.' };
  return OK;
}

/** Paso 5 — Configuración inicial. */
export function validarPasoSetup(d: DatosSetup): ResultadoValidacion {
  if (!d.salaNombre.trim()) {
    return { ok: false, error: 'Ingresa el nombre de tu primera sala.' };
  }
  if (!Number.isInteger(d.salaCupo) || d.salaCupo < 1) {
    return { ok: false, error: 'El cupo debe ser un número entero mayor a 0.' };
  }
  return OK;
}

// ── Armado del payload final ────────────────────────────────────────────────

export interface OnboardingPayload {
  nombre: string;
  email: string;
  password: string;
  gymNombre: string;
  slug: string;
  timezone: string;
  tier: TierSaas;
  /** Moneda derivada del mercado (timezone), no elegible. */
  moneda: MonedaSaas;
  /** Precio del SaaS en centavos: tier × moneda. */
  precioCentavos: number;
  colorPrimario: string;
  colorAcento: string;
  logoUrl: string | null;
  salaNombre: string;
  salaCupo: number;
}

/**
 * Arma el payload para la Netlify Function a partir del estado del wizard.
 * La moneda y el precio se derivan acá (timezone → moneda → precio del tier),
 * no los elige el usuario. Lanza si falta el tier (debería estar validado).
 */
export function construirPayloadOnboarding(state: OnboardingState): OnboardingPayload {
  if (!state.tier) {
    throw new Error('construirPayloadOnboarding: falta el tier');
  }
  const moneda = monedaPorTimezone(state.gym.timezone);
  return {
    nombre: state.cuenta.nombre.trim(),
    email: state.cuenta.email.trim().toLowerCase(),
    password: state.cuenta.password,
    gymNombre: state.gym.gymNombre.trim(),
    slug: state.gym.slug.trim().toLowerCase(),
    timezone: state.gym.timezone,
    tier: state.tier,
    moneda,
    precioCentavos: precioCentavos(state.tier, moneda),
    colorPrimario: state.setup.colorPrimario,
    colorAcento: state.setup.colorAcento,
    logoUrl: state.setup.logoUrl,
    salaNombre: state.setup.salaNombre.trim(),
    salaCupo: state.setup.salaCupo
  };
}
