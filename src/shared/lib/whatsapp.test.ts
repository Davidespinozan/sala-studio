import { describe, it, expect } from 'vitest';
import { telefonoWhatsApp, whatsappParaSocio } from './whatsapp';

describe('telefonoWhatsApp', () => {
  it('MX 10 dígitos → antepone 52', () => {
    expect(telefonoWhatsApp('6671234567')).toBe('526671234567');
    expect(telefonoWhatsApp('(667) 123 4567')).toBe('526671234567');
  });
  it('ya con lada 52 (12 dígitos) → igual', () => {
    expect(telefonoWhatsApp('526671234567')).toBe('526671234567');
  });
  it('521… legacy (13) → normaliza a 52…', () => {
    expect(telefonoWhatsApp('5216671234567')).toBe('526671234567');
  });
  it('vacío/invalid → null', () => {
    expect(telefonoWhatsApp(null)).toBeNull();
    expect(telefonoWhatsApp('')).toBeNull();
    expect(telefonoWhatsApp('123')).toBeNull();
  });
});

describe('whatsappParaSocio', () => {
  it('arma el link wa.me con el mensaje codificado', () => {
    expect(whatsappParaSocio('6671234567', 'Hola qué tal')).toBe(
      'https://wa.me/526671234567?text=Hola%20qu%C3%A9%20tal'
    );
  });
  it('sin teléfono usable → null', () => {
    expect(whatsappParaSocio(null, 'x')).toBeNull();
    expect(whatsappParaSocio('123', 'x')).toBeNull();
  });
});
