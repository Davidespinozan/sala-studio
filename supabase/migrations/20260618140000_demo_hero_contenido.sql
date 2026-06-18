-- ============================================================================
-- Demo: hero de healthyspace en modo CONTENIDO (card flotante), no full-bleed
-- ----------------------------------------------------------------------------
-- El hero del landing del gym demo estaba en 'completo' (imagen de borde a
-- borde). Lo pasamos a 'contenido' (card con esquinas redondeadas flotando
-- sobre el fondo) — es el default y lo que se quiere mostrar en la web de SALA.
-- Va por migración porque el guardrail proteger_demo_tenant bloquea editar la
-- config de healthyspace desde el admin autenticado.
-- ============================================================================

UPDATE tenants
SET config = jsonb_set(
  COALESCE(config, '{}'::jsonb),
  '{landing,hero,layout}',
  to_jsonb('contenido'::text),
  true
)
WHERE slug = 'healthyspace';
