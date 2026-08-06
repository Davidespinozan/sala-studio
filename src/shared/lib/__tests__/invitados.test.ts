import { describe, it, expect } from 'vitest';
import { invitadoVacio, ajustarInvitados } from '../invitados';

describe('invitadoVacio', () => {
  it('devuelve un invitado con todos los campos vacíos', () => {
    expect(invitadoVacio()).toEqual({ nombre: '', telefono: '', email: '' });
  });
});

describe('ajustarInvitados — la lista sigue al conteo del stepper', () => {
  const a = { nombre: 'Ana', telefono: '1', email: 'a@x' };
  const b = { nombre: 'Beto', telefono: '2', email: 'b@x' };
  const c = { nombre: 'Cami', telefono: '3', email: 'c@x' };

  it('crea N vacíos desde una lista vacía', () => {
    expect(ajustarInvitados([], 2)).toEqual([invitadoVacio(), invitadoVacio()]);
  });

  it('trunca conservando los primeros al reducir', () => {
    expect(ajustarInvitados([a, b, c], 2)).toEqual([a, b]);
  });

  it('crece conservando lo ya escrito y rellena con vacíos', () => {
    expect(ajustarInvitados([a], 3)).toEqual([a, invitadoVacio(), invitadoVacio()]);
  });

  it('a 0 devuelve lista vacía', () => {
    expect(ajustarInvitados([a], 0)).toEqual([]);
  });

  it('no muta la lista original', () => {
    const orig = [a];
    ajustarInvitados(orig, 3);
    expect(orig).toHaveLength(1);
  });
});
