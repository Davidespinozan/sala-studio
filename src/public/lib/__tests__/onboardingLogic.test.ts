import { describe, it, expect } from 'vitest';
import {
  validarSubdominio,
  sugerirSubdominio,
  validarEmail,
  validarPassword,
  validarPasoCuenta,
  validarPasoGym,
  validarPasoPlan,
  validarPasoSetup,
  construirPayloadOnboarding,
  SUBDOMINIOS_RESERVADOS,
  COLOR_PRIMARIO_DEFAULT,
  type OnboardingState
} from '../onboardingLogic';
import { monedaPorTimezone, precioCentavos, PLANES_SAAS } from '@shared/lib/planesSaas';

// ── Fixture: un estado de onboarding válido y completo ──
function estadoValido(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    cuenta: { nombre: 'Ana Ruiz', email: 'ana@yogasol.com', emailConfirm: 'ana@yogasol.com', password: 'segura123', passwordConfirm: 'segura123' },
    gym: { gymNombre: 'Yoga Sol', slug: 'yogasol', timezone: 'America/Mexico_City' },
    tier: 'pro',
    setup: { colorPrimario: COLOR_PRIMARIO_DEFAULT, colorAcento: COLOR_PRIMARIO_DEFAULT, logoUrl: null, salaNombre: 'Sala Principal', salaCupo: 15 },
    ...overrides
  };
}

// ============================================================================
// validarSubdominio — formato, reservados
// ============================================================================

describe('validarSubdominio', () => {
  it('acepta un subdominio válido', () => {
    expect(validarSubdominio('yogasol').ok).toBe(true);
    expect(validarSubdominio('crossfit-norte').ok).toBe(true);
    expect(validarSubdominio('box24').ok).toBe(true);
  });

  it('rechaza vacío', () => {
    expect(validarSubdominio('').ok).toBe(false);
    expect(validarSubdominio('   ').ok).toBe(false);
  });

  it('rechaza demasiado corto (< 3)', () => {
    expect(validarSubdominio('ab').ok).toBe(false);
  });

  it('rechaza demasiado largo (> 30)', () => {
    expect(validarSubdominio('a'.repeat(31)).ok).toBe(false);
  });

  it('normaliza mayúsculas a minúsculas (las acepta)', () => {
    expect(validarSubdominio('YogaSol').ok).toBe(true);
  });

  it('rechaza espacios y caracteres especiales', () => {
    expect(validarSubdominio('yoga sol').ok).toBe(false);
    expect(validarSubdominio('yoga_sol').ok).toBe(false);
    expect(validarSubdominio('yoga.sol').ok).toBe(false);
    expect(validarSubdominio('yogá').ok).toBe(false);
  });

  it('rechaza guión al inicio o al final', () => {
    expect(validarSubdominio('-yogasol').ok).toBe(false);
    expect(validarSubdominio('yogasol-').ok).toBe(false);
  });

  it('rechaza guiones dobles', () => {
    expect(validarSubdominio('yoga--sol').ok).toBe(false);
  });

  it('rechaza subdominios reservados', () => {
    expect(validarSubdominio('admin').ok).toBe(false);
    expect(validarSubdominio('www').ok).toBe(false);
    expect(validarSubdominio('app').ok).toBe(false);
    expect(validarSubdominio('api').ok).toBe(false);
    expect(validarSubdominio('sala-demo').ok).toBe(false);
  });

  it('todos los reservados son rechazados', () => {
    for (const r of SUBDOMINIOS_RESERVADOS) {
      expect(validarSubdominio(r).ok).toBe(false);
    }
  });

  it('normaliza espacios y mayúsculas antes de validar', () => {
    expect(validarSubdominio('  YogaSol  ').ok).toBe(true); // trim + minúsculas
    expect(validarSubdominio('  yogasol  ').ok).toBe(true);
  });
});

// ============================================================================
// sugerirSubdominio
// ============================================================================

describe('sugerirSubdominio', () => {
  it('convierte un nombre con espacios a slug', () => {
    expect(sugerirSubdominio('Yoga Sol')).toBe('yoga-sol');
  });

  it('quita acentos', () => {
    expect(sugerirSubdominio('Pilates Córdoba')).toBe('pilates-cordoba');
  });

  it('colapsa caracteres no válidos', () => {
    expect(sugerirSubdominio('Box 24/7 — Norte!')).toBe('box-24-7-norte');
  });

  it('no deja guiones al inicio/fin', () => {
    expect(sugerirSubdominio('  Gym  ')).toBe('gym');
    expect(sugerirSubdominio('!!Gym!!')).toBe('gym');
  });
});

// ============================================================================
// validarEmail / validarPassword
// ============================================================================

describe('validarEmail', () => {
  it('acepta emails válidos', () => {
    expect(validarEmail('ana@yogasol.com').ok).toBe(true);
    expect(validarEmail('a.b+c@dominio.mx').ok).toBe(true);
  });
  it('rechaza vacío y formatos inválidos', () => {
    expect(validarEmail('').ok).toBe(false);
    expect(validarEmail('ana').ok).toBe(false);
    expect(validarEmail('ana@').ok).toBe(false);
    expect(validarEmail('ana@dominio').ok).toBe(false);
    expect(validarEmail('ana dominio.com').ok).toBe(false);
  });
});

describe('validarPassword', () => {
  it('acepta una contraseña fuerte', () => {
    expect(validarPassword('segura123').ok).toBe(true);
  });
  it('rechaza menos de 8 caracteres', () => {
    expect(validarPassword('abc123').ok).toBe(false);
  });
  it('rechaza sin letra', () => {
    expect(validarPassword('12345678').ok).toBe(false);
  });
  it('rechaza sin número', () => {
    expect(validarPassword('sololetras').ok).toBe(false);
  });
});

// ============================================================================
// Validación por paso del wizard
// ============================================================================

describe('validarPasoCuenta', () => {
  it('acepta datos completos y válidos', () => {
    expect(validarPasoCuenta(estadoValido().cuenta).ok).toBe(true);
  });
  it('rechaza nombre vacío', () => {
    expect(validarPasoCuenta({ nombre: '  ', email: 'a@b.com', emailConfirm: 'a@b.com', password: 'segura123', passwordConfirm: 'segura123' }).ok).toBe(false);
  });
  it('rechaza email inválido', () => {
    expect(validarPasoCuenta({ nombre: 'Ana', email: 'mal', emailConfirm: 'mal', password: 'segura123', passwordConfirm: 'segura123' }).ok).toBe(false);
  });
  it('rechaza password débil', () => {
    expect(validarPasoCuenta({ nombre: 'Ana', email: 'a@b.com', emailConfirm: 'a@b.com', password: 'corta', passwordConfirm: 'corta' }).ok).toBe(false);
  });
  it('rechaza si los emails no coinciden', () => {
    expect(validarPasoCuenta({ nombre: 'Ana', email: 'a@b.com', emailConfirm: 'a@c.com', password: 'segura123', passwordConfirm: 'segura123' }).ok).toBe(false);
  });
  it('rechaza si las contraseñas no coinciden', () => {
    expect(validarPasoCuenta({ nombre: 'Ana', email: 'a@b.com', emailConfirm: 'a@b.com', password: 'segura123', passwordConfirm: 'segura124' }).ok).toBe(false);
  });
});

describe('validarPasoGym', () => {
  it('acepta datos completos y válidos', () => {
    expect(validarPasoGym(estadoValido().gym).ok).toBe(true);
  });
  it('rechaza nombre de gym vacío', () => {
    expect(validarPasoGym({ gymNombre: '', slug: 'yogasol', timezone: 'America/Mexico_City' }).ok).toBe(false);
  });
  it('rechaza slug inválido', () => {
    expect(validarPasoGym({ gymNombre: 'Yoga Sol', slug: 'A B', timezone: 'America/Mexico_City' }).ok).toBe(false);
  });
  it('rechaza slug reservado', () => {
    expect(validarPasoGym({ gymNombre: 'Yoga Sol', slug: 'admin', timezone: 'America/Mexico_City' }).ok).toBe(false);
  });
  it('rechaza timezone vacía', () => {
    expect(validarPasoGym({ gymNombre: 'Yoga Sol', slug: 'yogasol', timezone: '' }).ok).toBe(false);
  });
});

describe('validarPasoPlan', () => {
  it('acepta un tier elegido', () => {
    expect(validarPasoPlan('starter').ok).toBe(true);
    expect(validarPasoPlan('business').ok).toBe(true);
  });
  it('rechaza sin tier', () => {
    expect(validarPasoPlan(null).ok).toBe(false);
  });
});

describe('validarPasoSetup', () => {
  it('acepta setup válido', () => {
    expect(validarPasoSetup(estadoValido().setup).ok).toBe(true);
  });
  it('rechaza sala sin nombre', () => {
    expect(validarPasoSetup({ colorPrimario: '#000', colorAcento: '#000', logoUrl: null, salaNombre: '  ', salaCupo: 10 }).ok).toBe(false);
  });
  it('rechaza cupo 0 o negativo', () => {
    expect(validarPasoSetup({ colorPrimario: '#000', colorAcento: '#000', logoUrl: null, salaNombre: 'Sala', salaCupo: 0 }).ok).toBe(false);
    expect(validarPasoSetup({ colorPrimario: '#000', colorAcento: '#000', logoUrl: null, salaNombre: 'Sala', salaCupo: -3 }).ok).toBe(false);
  });
  it('rechaza cupo no entero', () => {
    expect(validarPasoSetup({ colorPrimario: '#000', colorAcento: '#000', logoUrl: null, salaNombre: 'Sala', salaCupo: 8.5 }).ok).toBe(false);
  });
});

// ============================================================================
// Derivación de moneda por timezone (mercado)
// ============================================================================

describe('monedaPorTimezone', () => {
  it('timezones de México → MXN', () => {
    expect(monedaPorTimezone('America/Mexico_City')).toBe('mxn');
    expect(monedaPorTimezone('America/Mazatlan')).toBe('mxn');
    expect(monedaPorTimezone('America/Cancun')).toBe('mxn');
    expect(monedaPorTimezone('America/Tijuana')).toBe('mxn');
  });
  it('timezones de Europa → EUR', () => {
    expect(monedaPorTimezone('Europe/Madrid')).toBe('eur');
    expect(monedaPorTimezone('Europe/Berlin')).toBe('eur');
  });
  it('resto del mundo (LATAM, USA) → USD', () => {
    expect(monedaPorTimezone('America/Bogota')).toBe('usd');
    expect(monedaPorTimezone('America/Argentina/Buenos_Aires')).toBe('usd');
    expect(monedaPorTimezone('America/Lima')).toBe('usd');
    expect(monedaPorTimezone('America/Santiago')).toBe('usd');
    expect(monedaPorTimezone('America/New_York')).toBe('usd');
  });
});

// ============================================================================
// Precio por tier + moneda
// ============================================================================

describe('precioCentavos', () => {
  it('coincide con la definición comercial (× 100)', () => {
    expect(precioCentavos('starter', 'mxn')).toBe(190000);
    expect(precioCentavos('pro', 'mxn')).toBe(390000);
    expect(precioCentavos('business', 'mxn')).toBe(790000);
    expect(precioCentavos('starter', 'usd')).toBe(12900);
    expect(precioCentavos('pro', 'usd')).toBe(27900);
    expect(precioCentavos('business', 'usd')).toBe(54900);
    expect(precioCentavos('starter', 'eur')).toBe(11900);
    expect(precioCentavos('pro', 'eur')).toBe(26900);
    expect(precioCentavos('business', 'eur')).toBe(49900);
  });
  it('los límites de miembros por tier son los esperados', () => {
    expect(PLANES_SAAS.starter.maxMiembros).toBe(200);
    expect(PLANES_SAAS.pro.maxMiembros).toBe(600);
    expect(PLANES_SAAS.business.maxMiembros).toBeNull();
  });
});

// ============================================================================
// construirPayloadOnboarding — armado del objeto que crea el tenant
// ============================================================================

describe('construirPayloadOnboarding', () => {
  it('arma el payload con los datos del wizard', () => {
    const p = construirPayloadOnboarding(estadoValido());
    expect(p.gymNombre).toBe('Yoga Sol');
    expect(p.slug).toBe('yogasol');
    expect(p.timezone).toBe('America/Mexico_City');
    expect(p.tier).toBe('pro');
    expect(p.salaNombre).toBe('Sala Principal');
    expect(p.salaCupo).toBe(15);
    expect(p.colorPrimario).toBe(COLOR_PRIMARIO_DEFAULT);
    expect(p.logoUrl).toBeNull();
  });

  it('deriva la moneda y el precio del mercado (México → MXN)', () => {
    const p = construirPayloadOnboarding(estadoValido({ tier: 'pro' }));
    expect(p.moneda).toBe('mxn');
    expect(p.precioCentavos).toBe(390000);
  });

  it('deriva EUR para un gym europeo', () => {
    const p = construirPayloadOnboarding(
      estadoValido({ tier: 'starter', gym: { gymNombre: 'Yoga Sol', slug: 'yogasol', timezone: 'Europe/Madrid' } })
    );
    expect(p.moneda).toBe('eur');
    expect(p.precioCentavos).toBe(11900);
  });

  it('deriva USD para el resto del mundo', () => {
    const p = construirPayloadOnboarding(
      estadoValido({ tier: 'business', gym: { gymNombre: 'Box', slug: 'box-bsas', timezone: 'America/Argentina/Buenos_Aires' } })
    );
    expect(p.moneda).toBe('usd');
    expect(p.precioCentavos).toBe(54900);
  });

  it('normaliza email (trim + minúsculas) y slug', () => {
    const p = construirPayloadOnboarding(
      estadoValido({
        cuenta: { nombre: '  Ana  ', email: '  Ana@YogaSol.COM ', emailConfirm: '  Ana@YogaSol.COM ', password: 'segura123', passwordConfirm: 'segura123' },
        gym: { gymNombre: '  Yoga Sol  ', slug: '  YogaSol ', timezone: 'America/Mexico_City' }
      })
    );
    expect(p.email).toBe('ana@yogasol.com');
    expect(p.slug).toBe('yogasol');
    expect(p.nombre).toBe('Ana');
    expect(p.gymNombre).toBe('Yoga Sol');
  });

  it('lanza si no se eligió un tier', () => {
    expect(() => construirPayloadOnboarding(estadoValido({ tier: null }))).toThrow();
  });
});
