-- ════════════════════════════════════════════════════════════════════════════
-- Paleta MONOCROMÁTICA para SALA (sala-demo): acento = primary (verde salvia)
-- ════════════════════════════════════════════════════════════════════════════
-- El branding del tenant guardaba un color_accent (coral) que applyBranding
-- aplicaba como --sala-accent, generando el naranja en toda la app.
--
-- Decisión de marca: SALA pasa a una paleta monocromática (verde salvia +
-- neutros), sin segundo color de acento. Quitamos color_accent del branding:
-- al no estar, applyBranding hace que el acento herede el primary (ver
-- TenantProvider: `accent = branding.color_accent || primary`).
--
-- Sólo afecta a sala-demo. Otros tenants conservan su color_accent si lo
-- definieron, o heredan su primary si no — el sistema sigue siendo multi-tenant.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE tenants
SET branding = branding - 'color_accent'
WHERE slug = 'sala-demo';
