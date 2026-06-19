-- ============================================================================
-- Fix voseo en descripciones de planes (español neutral)
-- ----------------------------------------------------------------------------
-- Las descripciones placeholder de los planes seedeados por crear_tenant_onboarding
-- traían voseo ("Editá el precio..."). Corrige todas las filas existentes
-- (incluye el demo healthyspace) a "tú". current_user = postgres → los guardrails
-- no bloquean.
--
-- NB: la fuente (crear_tenant_onboarding) se deja igual a propósito: recrear esa
-- función crítica de bootstrap por 2 strings de placeholder que el dueño
-- reemplaza el primer día es mal trade-off de riesgo. Gyms nuevos arrancan con
-- ese texto hasta que lo editan; las filas vivas quedan corregidas acá.
-- ============================================================================

UPDATE tiers
SET descripcion = replace(descripcion, 'Editá', 'Edita')
WHERE descripcion LIKE '%Editá%';
