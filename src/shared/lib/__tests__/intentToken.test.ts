import { describe, it, expect, beforeEach } from 'vitest';
import { beginIntent, resolveIntent } from '../intentToken';

describe('W6-B2 — intentToken: una acción = un token, estable ante reintentos', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* noop */ }
  });

  it('doble-click / re-render / reintento del MISMO intento → mismo token', () => {
    const t1 = beginIntent('tienda-compra');
    const t2 = beginIntent('tienda-compra'); // doble-click
    const t3 = beginIntent('tienda-compra'); // re-render de React
    expect(t1).toBe(t2);
    expect(t2).toBe(t3);
  });

  it('timeout y reintento (sin resolver) → mismo token', () => {
    const t1 = beginIntent('tienda-compra');
    // la respuesta se perdió → NO se llama resolveIntent → el reintento reusa:
    const t2 = beginIntent('tienda-compra');
    expect(t2).toBe(t1);
  });

  it('browser refresh / reinicio (localStorage persiste) → mismo token', () => {
    const t1 = beginIntent('tienda-compra');
    // Refresh y reinicio del navegador re-ejecutan el módulo pero localStorage
    // sobrevive: lo simulamos leyendo de nuevo sin limpiar.
    const t2 = beginIntent('tienda-compra');
    expect(t2).toBe(t1);
    expect(localStorage.getItem('sala:intent:tienda-compra')).toBe(t1);
  });

  it('acción resuelta → la siguiente acción acuña un token NUEVO', () => {
    const compra1 = beginIntent('tienda-compra');
    resolveIntent('tienda-compra'); // respuesta recibida (pagó o rechazo final)
    const compra2 = beginIntent('tienda-compra');
    expect(compra2).not.toBe(compra1);
  });

  it('dos carritos idénticos comprados A PROPÓSITO (resuelto en medio) → tokens distintos', () => {
    const a = beginIntent('tienda-compra');
    resolveIntent('tienda-compra');
    const b = beginIntent('tienda-compra');
    expect(a).not.toBe(b);
  });

  it('acciones distintas (namespaces distintos) → tokens distintos', () => {
    const compra = beginIntent('tienda-compra');
    const swap = beginIntent('membership:tier_x');
    const addon = beginIntent('addon-tienda-activar');
    expect(new Set([compra, swap, addon]).size).toBe(3);
  });

  it('plan A → B → A → B (resuelto entre cada acción) → 4 tokens distintos', () => {
    const a1 = beginIntent('membership:A'); resolveIntent('membership:A');
    const b1 = beginIntent('membership:B'); resolveIntent('membership:B');
    const a2 = beginIntent('membership:A'); resolveIntent('membership:A');
    const b2 = beginIntent('membership:B'); resolveIntent('membership:B');
    expect(new Set([a1, b1, a2, b2]).size).toBe(4);
  });

  it('addon on → off → on (resuelto entre cada acción) → tokens distintos', () => {
    const on1 = beginIntent('addon-tienda-activar'); resolveIntent('addon-tienda-activar');
    const off = beginIntent('addon-tienda-cancelar'); resolveIntent('addon-tienda-cancelar');
    const on2 = beginIntent('addon-tienda-activar'); resolveIntent('addon-tienda-activar');
    expect(new Set([on1, off, on2]).size).toBe(3);
  });

  it('solo al limpiar el storage (borrar datos del sitio) se acuña token nuevo', () => {
    // Con localStorage el token sobrevive refresh/reinicio; únicamente borrarlo
    // explícitamente (resolveIntent o limpiar datos del sitio) acuña uno nuevo.
    const t1 = beginIntent('tienda-compra');
    localStorage.clear();
    const t2 = beginIntent('tienda-compra');
    expect(t2).not.toBe(t1);
  });

  it('ns vacío → lanza (no namespace, no token)', () => {
    expect(() => beginIntent('')).toThrow(/INTENT_SIN_NS/);
  });

  it('el token tiene pinta de nonce seguro (pasa la validación del server)', () => {
    const t = beginIntent('tienda-compra');
    expect(t).toMatch(/^[A-Za-z0-9:_-]{8,200}$/);
  });
});
