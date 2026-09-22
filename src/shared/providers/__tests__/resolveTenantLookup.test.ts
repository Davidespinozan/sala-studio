import { describe, it, expect, afterEach } from 'vitest';
import { resolveTenantLookup } from '../TenantProvider';

// Cómo se resuelve el tenant del host: por SLUG en los subdominios de SALA, y por
// DOMINIO PROPIO (columna dominio_app) cuando el gym trae su propia URL comprada
// (ej. The Core Studio en thecorestudio.app). marketing/dev caen al demo por slug.
function setHostname(hostname: string) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, hostname },
    writable: true,
    configurable: true
  });
}

describe('resolveTenantLookup', () => {
  afterEach(() => setHostname('localhost'));

  it('subdominio de SALA → por slug', () => {
    setHostname('numawellness.salastudio.app');
    expect(resolveTenantLookup()).toEqual({ by: 'slug', value: 'numawellness' });
    setHostname('pilates-noria.salastudio.app');
    expect(resolveTenantLookup()).toEqual({ by: 'slug', value: 'pilates-noria' });
  });

  it('marketing y dev/preview → demo por slug', () => {
    setHostname('salastudio.app');
    expect(resolveTenantLookup()).toEqual({ by: 'slug', value: 'healthyspace' });
    setHostname('localhost');
    expect(resolveTenantLookup()).toEqual({ by: 'slug', value: 'healthyspace' });
    setHostname('deploy-preview-42--sala.netlify.app');
    expect(resolveTenantLookup()).toEqual({ by: 'slug', value: 'healthyspace' });
  });

  it('dominio propio del gym → por dominio_app (normaliza www)', () => {
    setHostname('thecorestudio.app');
    expect(resolveTenantLookup()).toEqual({ by: 'dominio', value: 'thecorestudio.app' });
    setHostname('www.thecorestudio.app');
    expect(resolveTenantLookup()).toEqual({ by: 'dominio', value: 'thecorestudio.app' });
    setHostname('reservas.polesport.mx');
    expect(resolveTenantLookup()).toEqual({ by: 'dominio', value: 'reservas.polesport.mx' });
  });
});
