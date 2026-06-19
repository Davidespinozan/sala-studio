-- ============================================================================
-- DEMO healthyspace — limpieza de copy del landing + español NEUTRAL.
-- ----------------------------------------------------------------------------
--  1) Saca el eyebrow del hero ("Healthy Space Club"): redundante con el logo
--     y tapaba la foto. Hero queda con el título grande solo.
--  2) Acorta el título de "Cómo funciona" (sección 2): era muy largo y robaba
--     espacio en móvil → "Empieza en 3 pasos." ("en 3 pasos." en dorado).
--  3) Neutraliza el español del copy sembrado (era voseo): hero.subtitulo y
--     cta_final.subtitulo pasan a tuteo neutral. (El resto del copy del demo
--     sale de los defaults del código, ya neutralizados en useLandingConfig.)
-- Va por migración porque la config del demo está protegida; un tenant real lo
-- edita desde Admin → Landing.
-- ============================================================================

UPDATE tenants
SET config = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
      COALESCE(config, '{}'::jsonb),
      '{landing,hero,eyebrow}',            '""'::jsonb,            true),
      '{landing,hero,subtitulo}',          to_jsonb('Un espacio para entrenar a tu ritmo. Reserva tus clases desde la app y haz del movimiento un hábito.'::text), true),
      '{landing,post_hero,titulo}',        '"Empieza"'::jsonb,     true),
      '{landing,post_hero,titulo_accent}', '"en 3 pasos."'::jsonb, true),
      '{landing,cta_final,subtitulo}',     to_jsonb('Escríbenos y armamos la membresía que va contigo.'::text), true)
WHERE slug = 'healthyspace';
