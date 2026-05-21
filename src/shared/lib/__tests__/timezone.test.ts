import { describe, it, expect } from 'vitest';
import {
  getSucursalTimezone,
  getTenantTimezone,
  instanteDeClase,
  DEFAULT_TIMEZONE
} from '../timezone';

// ============================================================================
// getSucursalTimezone — derivación de tz por sucursal (multisede-3)
// ============================================================================

describe('getSucursalTimezone', () => {
  it('usa la tz propia de la sucursal cuando está definida', () => {
    expect(getSucursalTimezone('America/Mexico_City', 'America/Mexico_City')).toBe(
      'America/Mexico_City'
    );
    // Una sucursal europea conserva su tz aunque el tenant sea de México.
    expect(getSucursalTimezone('Europe/Madrid', 'America/Mexico_City')).toBe('Europe/Madrid');
  });

  it('cae al fallback (tz del tenant) cuando la sucursal no tiene tz', () => {
    expect(getSucursalTimezone(null, 'America/Bogota')).toBe('America/Bogota');
    expect(getSucursalTimezone(undefined, 'America/Bogota')).toBe('America/Bogota');
    expect(getSucursalTimezone('', 'America/Bogota')).toBe('America/Bogota');
  });

  it('cae al default cuando no hay tz ni fallback', () => {
    expect(getSucursalTimezone(null)).toBe(DEFAULT_TIMEZONE);
    expect(getSucursalTimezone('', '')).toBe(DEFAULT_TIMEZONE);
    expect(getSucursalTimezone(undefined, null)).toBe(DEFAULT_TIMEZONE);
  });

  it('integra con getTenantTimezone como fallback', () => {
    const tenant = { config: { timezone: 'America/Argentina/Buenos_Aires' } };
    expect(getSucursalTimezone(null, getTenantTimezone(tenant))).toBe(
      'America/Argentina/Buenos_Aires'
    );
    expect(getSucursalTimezone('Europe/Madrid', getTenantTimezone(tenant))).toBe('Europe/Madrid');
  });
});

// ============================================================================
// instanteDeClase — la MISMA hora de pared cae en instantes distintos según
// la tz de la sucursal. Esto es lo que hace que una clase 07:00 en una sede
// de Madrid no se confunda con 07:00 en una sede de México.
// ============================================================================

describe('instanteDeClase — wall-clock por sucursal', () => {
  it('07:00 en Madrid y 07:00 en México son instantes distintos', () => {
    const fecha = '2026-06-01';
    const hora = '07:00';
    const enMadrid = instanteDeClase(fecha, hora, 'Europe/Madrid');
    const enMexico = instanteDeClase(fecha, hora, 'America/Mexico_City');

    expect(enMadrid.getTime()).not.toBe(enMexico.getTime());
    // Madrid en junio = CEST (UTC+2) → 07:00 local = 05:00 UTC.
    expect(enMadrid.getUTCHours()).toBe(5);
    // Ciudad de México = UTC-6 todo el año → 07:00 local = 13:00 UTC.
    expect(enMexico.getUTCHours()).toBe(13);
  });

  it('la tz derivada de la sucursal alimenta correctamente la conversión', () => {
    const tenantTz = 'America/Mexico_City';
    const tzSucursalCentro = getSucursalTimezone('Europe/Madrid', tenantTz);
    const tzSucursalPrincipal = getSucursalTimezone(null, tenantTz);

    const centro = instanteDeClase('2026-06-01', '19:00', tzSucursalCentro);
    const principal = instanteDeClase('2026-06-01', '19:00', tzSucursalPrincipal);

    expect(centro.getTime()).not.toBe(principal.getTime());
  });
});
