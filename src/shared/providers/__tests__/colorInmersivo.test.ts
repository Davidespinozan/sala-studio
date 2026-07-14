import { describe, it, expect } from 'vitest';
import {
  pickImmersiveMix,
  mixHex,
  contrastRatio,
  relativeLuminance
} from '../TenantProvider';

/**
 * El color de marca del tenant se pinta TAL CUAL en el sidebar, el header y los
 * heros. La única razón para oscurecerlo es que el texto blanco encima deje de
 * leerse. Esta es la garantía que no se puede romper: pase lo que pase con el
 * color que elija un gym, el texto tiene que seguir siendo legible.
 */

const ANCLA_OSCURA = '#0A0F0C';

/** Marcas de distinto tono: de casi negra a casi blanca. */
const MARCAS = [
  '#1A1F1C', // casi negra
  '#3D6B52', // verde SALA
  '#2563EB', // azul
  '#7C3AED', // violeta
  '#C44A35', // rojo ladrillo
  '#E11D48', // rosa fuerte
  '#8B5E3C', // marrón (numa)
  '#D4A93C', // dorado
  '#FFD400', // amarillo puro
  '#F5F5F0'  // casi blanca
];

describe('pickImmersiveMix — la garantía de legibilidad', () => {
  it.each(MARCAS)('con %s, el texto blanco pasa 4.5:1 sobre el fondo', (marca) => {
    const { top } = pickImmersiveMix(marca);
    const fondo = mixHex(marca, top, ANCLA_OSCURA);
    expect(contrastRatio(fondo, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
  });

  it.each(MARCAS)('con %s, el texto tenue también pasa 4.5:1', (marca) => {
    const { top, mutedOpacity } = pickImmersiveMix(marca);
    const fondo = mixHex(marca, top, ANCLA_OSCURA);
    const textoTenue = mixHex('#FFFFFF', mutedOpacity * 100, fondo);
    expect(contrastRatio(textoTenue, fondo)).toBeGreaterThanOrEqual(4.5);
  });

  it('una marca de tono medio u oscuro se muestra INTACTA (100%)', () => {
    // Este es el punto de todo el cambio: el gym ve SU color, no una versión
    // apagada. Antes se oscurecía siempre a un 80% fijo.
    for (const marca of ['#3D6B52', '#2563EB', '#C44A35', '#7C3AED', '#1A1F1C']) {
      expect(pickImmersiveMix(marca).top).toBe(100);
    }
  });

  it('solo una marca CLARA se oscurece, y lo mínimo necesario', () => {
    const amarillo = pickImmersiveMix('#FFD400');
    expect(amarillo.top).toBeLessThan(100);

    // "Lo mínimo": un punto más de color ya rompería el contraste.
    const unPocoMas = mixHex('#FFD400', amarillo.top + 1, ANCLA_OSCURA);
    expect(contrastRatio(unPocoMas, '#FFFFFF')).toBeLessThan(4.5);
  });

  it('el fondo del degradado nunca es más claro que el tope', () => {
    // Si lo fuera, el contraste del texto podría romperse abajo aunque pase arriba.
    for (const marca of MARCAS) {
      const { top, bottom } = pickImmersiveMix(marca);
      expect(bottom).toBeLessThanOrEqual(top);
    }
  });
});

describe('relativeLuminance', () => {
  it('el blanco es 1 y el negro es 0', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 2);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 2);
  });

  it('un hex inválido no explota: cae al medio', () => {
    expect(relativeLuminance('no-es-un-color')).toBe(0.5);
  });
});
