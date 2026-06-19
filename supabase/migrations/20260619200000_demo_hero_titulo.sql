-- ============================================================================
-- DEMO healthyspace — nuevo título del hero.
-- ----------------------------------------------------------------------------
-- "Tu Club. Tu Gym." (línea 1) + "Tu Hogar." en dorado (línea 2, el acento va
-- en segunda línea por el <br/> del render). Saca "Sin límites".
-- Va por migración porque la config del demo está protegida por guardrail; un
-- tenant real edita esto desde Admin → Landing.
-- ============================================================================

UPDATE tenants
SET config = jsonb_set(
  jsonb_set(
    COALESCE(config, '{}'::jsonb),
    '{landing,hero,titulo}', '"Tu Club. Tu Gym."'::jsonb, true
  ),
  '{landing,hero,titulo_accent}', '"Tu Hogar."'::jsonb, true
)
WHERE slug = 'healthyspace';
