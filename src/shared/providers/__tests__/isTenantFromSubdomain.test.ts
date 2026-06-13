import { describe, it, expect, afterEach } from 'vitest';
import { isTenantFromSubdomain } from '../TenantProvider';

// Guard de #4: en localhost/preview el tenant cae a 'sala-demo' por fallback, NO
// por subdominio → el TenantGuard NO debe bloquear (si no, ninguna cuenta real
// entra en local/preview). En subdominio real de producción SÍ debe bloquear el
// cruce de tenants. Esta función decide cuál de los dos mundos es.
function setHostname(hostname: string) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, hostname },
    writable: true,
    configurable: true,
  });
}

describe('isTenantFromSubdomain', () => {
  afterEach(() => setHostname('localhost'));

  it('false en fallbacks de dev/preview (no autoritativo → no bloquear)', () => {
    setHostname('localhost');
    expect(isTenantFromSubdomain()).toBe(false);
    setHostname('127.0.0.1');
    expect(isTenantFromSubdomain()).toBe(false);
    setHostname('deploy-preview-42--sala.netlify.app');
    expect(isTenantFromSubdomain()).toBe(false);
  });

  it('false en hosts de marketing (raíz de SALA, no un tenant)', () => {
    setHostname('salastudio.app');
    expect(isTenantFromSubdomain()).toBe(false);
    setHostname('www.salastudio.app');
    expect(isTenantFromSubdomain()).toBe(false);
  });

  it('true en subdominio real de producción (autoritativo → sí bloquear cruce)', () => {
    setHostname('pilates-noria.sala.app');
    expect(isTenantFromSubdomain()).toBe(true);
    setHostname('app.sala.studio');
    expect(isTenantFromSubdomain()).toBe(true);
  });
});
