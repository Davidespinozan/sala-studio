import { describe, it, expect } from 'vitest';
import { agruparPorClase, formatearHora, esManana, type HorarioBase } from '../programa';

/** El programa real de un gym de una sola sala: una clase distinta por día. */
const HORARIOS: HorarioBase[] = [
  // Lunes y jueves, 10 franjas
  ...['05:00', '06:00', '07:00', '08:00', '09:00', '16:00', '17:00', '18:00', '19:00', '20:00'].map(
    (h) => ({
      nombre: 'PWR + METCon',
      descripcion: 'Tren inferior + CardioHiit',
      dias_semana: [1, 4],
      hora_inicio: `${h}:00`,
      cupo_max: 15
    })
  ),
  // Sábado, 4 franjas, otro cupo
  ...['06:00', '07:00', '08:00', '09:00'].map((h) => ({
    nombre: 'FUERZA + CardioHiit',
    descripcion: 'Fuerza + CardioHiit',
    dias_semana: [6],
    hora_inicio: `${h}:00`,
    cupo_max: 20
  }))
];

describe('agruparPorClase', () => {
  it('junta las 10 franjas del lunes en UNA sola clase', () => {
    const clases = agruparPorClase(HORARIOS, 1);
    expect(clases).toHaveLength(1);
    expect(clases[0].nombre).toBe('PWR + METCon');
    expect(clases[0].enfoque).toBe('Tren inferior + CardioHiit');
    expect(clases[0].horas).toHaveLength(10);
  });

  it('ordena las horas de la mañana a la tarde (16:00 después de 09:00)', () => {
    const [clase] = agruparPorClase(HORARIOS, 1);
    expect(clase.horas[0]).toBe('05:00');
    expect(clase.horas[4]).toBe('09:00');
    expect(clase.horas[5]).toBe('16:00');
    expect(clase.horas[9]).toBe('20:00');
  });

  it('el cupo es de la CLASE: 15 entre semana, 20 el sábado', () => {
    expect(agruparPorClase(HORARIOS, 1)[0].cupo).toBe(15);
    expect(agruparPorClase(HORARIOS, 6)[0].cupo).toBe(20);
  });

  it('un día sin clases no devuelve nada (domingo)', () => {
    expect(agruparPorClase(HORARIOS, 0)).toHaveLength(0);
  });

  it('si hay DOS entrenamientos distintos el mismo día, quedan separados', () => {
    const mixto: HorarioBase[] = [
      { nombre: 'Fuerza', descripcion: 'A', dias_semana: [2], hora_inicio: '07:00:00', cupo_max: 10 },
      { nombre: 'Fuerza', descripcion: 'A', dias_semana: [2], hora_inicio: '08:00:00', cupo_max: 10 },
      { nombre: 'Yoga', descripcion: 'B', dias_semana: [2], hora_inicio: '19:00:00', cupo_max: 12 }
    ];
    const clases = agruparPorClase(mixto, 2);
    expect(clases).toHaveLength(2);
    expect(clases[0].horas).toEqual(['07:00', '08:00']);
    expect(clases[1].horas).toEqual(['19:00']);
  });
});

describe('formatearHora', () => {
  it('pasa a 12 horas sin AM/PM (la franja lo dice)', () => {
    expect(formatearHora('05:00')).toBe('5:00');
    expect(formatearHora('16:00')).toBe('4:00');
    expect(formatearHora('20:00')).toBe('8:00');
  });

  it('el mediodía y la medianoche son 12, no 0', () => {
    expect(formatearHora('12:00')).toBe('12:00');
    expect(formatearHora('00:00')).toBe('12:00');
  });

  it('conserva los minutos si la clase no cae en punto', () => {
    expect(formatearHora('18:30')).toBe('6:30');
  });
});

describe('esManana', () => {
  it('el mediodía ya es tarde', () => {
    expect(esManana('11:59')).toBe(true);
    expect(esManana('12:00')).toBe(false);
    expect(esManana('16:00')).toBe(false);
  });
});
