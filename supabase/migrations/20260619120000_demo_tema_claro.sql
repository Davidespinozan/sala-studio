-- ============================================================================
-- Revertir healthyspace a tema CLARO (el oscuro no quedó bien).
-- ----------------------------------------------------------------------------
-- La fundación del tema (applyTema + el toggle por tenant) queda en el código
-- para el futuro; solo cambiamos healthyspace de 'oscuro' a 'claro'.
-- Va por migración porque el guardrail protege la config del demo.
-- ============================================================================

UPDATE tenants
SET config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('tema', 'claro')
WHERE slug = 'healthyspace';
