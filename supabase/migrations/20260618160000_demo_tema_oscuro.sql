-- ============================================================================
-- Tema del tenant (claro/oscuro) — config.tema. Demo healthyspace = oscuro.
-- ----------------------------------------------------------------------------
-- El tema OSCURO deriva los neutros (lienzo/superficies/texto) del PRIMARIO del
-- tenant → cada gym se viste de su color en versión oscura premium. Es editable
-- desde admin (config.tema). Acá ponemos healthyspace en 'oscuro' (default de los
-- demás tenants = ausente = 'claro', sin cambios).
-- Va por migración porque el guardrail bloquea editar la config de healthyspace
-- desde el admin autenticado.
-- ============================================================================

UPDATE tenants
SET config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('tema', 'oscuro')
WHERE slug = 'healthyspace';
