-- ============================================================================
-- DEMO HEALTHYSPACE · Lote 1 — limpiar textos de prueba de la landing
-- ----------------------------------------------------------------------------
-- El tenant santi (ahora healthyspace) traía placeholders de prueba en el copy
-- de la landing (config.landing): "hola como estan todos?", "HOLA HOLA",
-- "QUE ONDA QUE ONDA", "Ver membresias " (sin tilde). Los reemplazamos por copy
-- presentable, en el mismo tono voseo del resto de la landing.
--
-- Como los guardrails dejan la fila de tenants de solo lectura DESDE LA APP, el
-- contenido del demo se cura por migración (postgres) — acá.
-- ============================================================================

UPDATE tenants
SET config = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
      config,
      '{landing,hero,subtitulo}',
        to_jsonb('Un espacio para entrenar a tu ritmo. Reservá tus clases desde la app y hacé del movimiento un hábito.'::text), false),
      '{landing,hero,cta_texto}',     to_jsonb('Ver membresías'::text), false),
      '{landing,hero,titulo_accent}', to_jsonb('Sin límites'::text),    false),
      '{landing,cta_final,titulo}',    to_jsonb('¿Empezamos?'::text),    false),
      '{landing,cta_final,subtitulo}', to_jsonb('Escribinos y armamos la membresía que va con vos.'::text), false),
      '{landing,cta_final,eyebrow}',   to_jsonb('Culiacán · México'::text), false),
      '{landing,footer,tagline}',      to_jsonb('Studio · Culiacán'::text), false)
WHERE slug = 'healthyspace';
