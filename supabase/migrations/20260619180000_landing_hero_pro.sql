-- ============================================================================
-- LANDING DEL TENANT — Fase 1 (Hero pro). Demo healthyspace.
-- ----------------------------------------------------------------------------
-- El render y el editor de admin ya soportan: hero full-bleed (layout 'completo'),
-- 2º CTA (cta2_texto) y barra de stats (stats[]). Acá solo SEMBRAMOS el demo
-- para que se vea como la referencia. Merge sobre config.landing.hero → conserva
-- titulo, eyebrow, imágenes, etc. (la config del demo está protegida por guardrail,
-- por eso va en migración; un tenant real lo edita desde Admin → Landing).
-- ============================================================================

UPDATE tenants
SET config = jsonb_set(
  COALESCE(config, '{}'::jsonb),
  '{landing,hero}',
  COALESCE(config->'landing'->'hero', '{}'::jsonb) || jsonb_build_object(
    'layout', 'completo',
    'cta_texto', 'Reservar mi clase',
    'cta2_texto', 'Ver membresías',
    'cta2_link', '#membresias',
    'stats', jsonb_build_array(
      jsonb_build_object('valor', '4.9★', 'label', '+120 reseñas'),
      jsonb_build_object('valor', '500+', 'label', 'socios activos'),
      jsonb_build_object('valor', '30+',  'label', 'clases semanales'),
      jsonb_build_object('valor', '1',    'label', 'sede')
    )
  ),
  true
)
WHERE slug = 'healthyspace';
