import { describe, it, expect } from 'vitest';
import {
  sucursalesVisibles,
  resolverSucursalActiva,
  type AlcanceMembresia
} from '../sucursalScope';

const SEDES = [
  { id: 'a', nombre: 'Centro' },
  { id: 'b', nombre: 'Norte' },
  { id: 'c', nombre: 'Sur' }
];

const alcance = (over: Partial<AlcanceMembresia>): AlcanceMembresia => ({
  tier_acceso_todas_sucursales: true,
  sucursal_id: null,
  ...over
});

describe('sucursalesVisibles', () => {
  it('sin membresía (null) → todas las sedes', () => {
    expect(sucursalesVisibles(SEDES, null)).toEqual(SEDES);
  });

  it('plan con acceso a todas las sedes → todas (ignora sucursal_id)', () => {
    const r = sucursalesVisibles(SEDES, alcance({ tier_acceso_todas_sucursales: true, sucursal_id: 'a' }));
    expect(r).toEqual(SEDES);
  });

  it('plan de una sede CON sede definida → solo esa', () => {
    const r = sucursalesVisibles(SEDES, alcance({ tier_acceso_todas_sucursales: false, sucursal_id: 'b' }));
    expect(r).toEqual([{ id: 'b', nombre: 'Norte' }]);
  });

  it('plan de una sede SIN sede definida (null) → todas (no se puede restringir)', () => {
    const r = sucursalesVisibles(SEDES, alcance({ tier_acceso_todas_sucursales: false, sucursal_id: null }));
    expect(r).toEqual(SEDES);
  });

  it('plan de una sede cuya sede ya no está en la lista (desactivada) → ninguna', () => {
    const r = sucursalesVisibles(SEDES, alcance({ tier_acceso_todas_sucursales: false, sucursal_id: 'zzz' }));
    expect(r).toEqual([]);
  });

  it('no muta la lista de entrada', () => {
    const original = [...SEDES];
    sucursalesVisibles(SEDES, alcance({ tier_acceso_todas_sucursales: false, sucursal_id: 'b' }));
    expect(SEDES).toEqual(original);
  });

  it('lista vacía → vacía en cualquier caso', () => {
    expect(sucursalesVisibles([], null)).toEqual([]);
    expect(sucursalesVisibles([], alcance({ tier_acceso_todas_sucursales: false, sucursal_id: 'a' }))).toEqual([]);
  });
});

describe('resolverSucursalActiva', () => {
  it('la elegida sigue visible → la respeta', () => {
    expect(resolverSucursalActiva(SEDES, 'b')).toBe('b');
  });

  it('la elegida NO está visible → cae a la primera visible', () => {
    expect(resolverSucursalActiva(SEDES, 'zzz')).toBe('a');
  });

  it('sin elegida (null) → primera visible', () => {
    expect(resolverSucursalActiva(SEDES, null)).toBe('a');
  });

  it('una sola sede visible y elegida fuera → esa única sede', () => {
    expect(resolverSucursalActiva([{ id: 'b', nombre: 'Norte' }], 'a')).toBe('b');
  });

  it('sin sedes visibles → null', () => {
    expect(resolverSucursalActiva([], 'a')).toBeNull();
    expect(resolverSucursalActiva([], null)).toBeNull();
  });
});

// Composición real (igual que el provider): plan de una sede restringe y la
// resolución no deja una sede fuera del alcance como activa.
describe('integración alcance → sede activa', () => {
  it('plan de una sede: aunque la elegida sea otra, la activa cae en la suya', () => {
    const visibles = sucursalesVisibles(SEDES, alcance({ tier_acceso_todas_sucursales: false, sucursal_id: 'c' }));
    expect(resolverSucursalActiva(visibles, 'a')).toBe('c');
  });

  it('plan global: la elegida se respeta', () => {
    const visibles = sucursalesVisibles(SEDES, alcance({ tier_acceso_todas_sucursales: true, sucursal_id: 'a' }));
    expect(resolverSucursalActiva(visibles, 'b')).toBe('b');
  });
});
