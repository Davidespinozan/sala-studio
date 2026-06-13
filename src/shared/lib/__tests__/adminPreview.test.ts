import { describe, it, expect, beforeEach } from 'vitest';
import { isAdminPreview, latchAdminPreview, exitAdminPreview } from '../adminPreview';

// Latch de #5: el modo "VER COMO…" debe sobrevivir a navegaciones que NO
// arrastran ?demo=admin-preview. Si esto regresa, el admin se ejecta al
// segundo click o pierde el banner de "Volver al admin".
describe('adminPreview (latch del modo VER COMO)', () => {
  beforeEach(() => sessionStorage.clear());

  it('isAdminPreview: true cuando la URL trae el param', () => {
    expect(isAdminPreview('?demo=admin-preview')).toBe(true);
    expect(isAdminPreview(new URLSearchParams('demo=admin-preview'))).toBe(true);
  });

  it('isAdminPreview: false sin param ni sticky', () => {
    expect(isAdminPreview('')).toBe(false);
    expect(isAdminPreview('?demo=otro')).toBe(false);
  });

  it('latchAdminPreview persiste el modo solo si la URL trae el param', () => {
    latchAdminPreview('?foo=1');
    expect(isAdminPreview('')).toBe(false); // no se latcheó

    latchAdminPreview('?demo=admin-preview');
    // Ahora, aunque la URL ya no traiga el param (navegación interna), sigue activo.
    expect(isAdminPreview('')).toBe(true);
    expect(isAdminPreview('?demo=otro')).toBe(true);
  });

  it('exitAdminPreview limpia el latch (Volver al admin)', () => {
    latchAdminPreview('?demo=admin-preview');
    expect(isAdminPreview('')).toBe(true);

    exitAdminPreview();
    expect(isAdminPreview('')).toBe(false);
  });
});
