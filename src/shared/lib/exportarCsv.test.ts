import { describe, it, expect } from 'vitest';
import { construirCsv } from './exportarCsv';

describe('construirCsv', () => {
  it('arma encabezados + filas con BOM y CRLF', () => {
    const csv = construirCsv([{ a: '1', b: '2' }], [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' }
    ]);
    expect(csv).toBe('﻿"A","B"\r\n"1","2"');
  });

  it('escapa comillas, comas y saltos de línea', () => {
    const csv = construirCsv([{ nombre: 'Pérez, Juan "el rápido"\ncalle 1' }], [
      { key: 'nombre', label: 'Nombre' }
    ]);
    // Comillas dobladas, y todo entre comillas → comas/saltos no rompen columnas.
    expect(csv).toContain('"Pérez, Juan ""el rápido""\ncalle 1"');
  });

  it('celdas nulas/indefinidas quedan vacías', () => {
    const csv = construirCsv([{ a: null, b: undefined }], [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' }
    ]);
    expect(csv).toBe('﻿"A","B"\r\n"",""');
  });

  it('usa el formateador `valor` cuando se da', () => {
    const csv = construirCsv([{ centavos: 12345 }], [
      { key: 'centavos', label: 'Monto', valor: (f) => ((f.centavos as number) / 100).toFixed(2) }
    ]);
    expect(csv).toBe('﻿"Monto"\r\n"123.45"');
  });

  it('sin filas devuelve cadena vacía', () => {
    expect(construirCsv([])).toBe('');
  });
});
