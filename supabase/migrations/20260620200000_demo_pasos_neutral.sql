-- ============================================================================
-- DEMO healthyspace — pasos de "Cómo funciona" en español NEUTRAL.
-- ----------------------------------------------------------------------------
-- El config del demo tenía los 3 pasos en voseo (seed viejo: "Pickeá / Elegí /
-- Mostrá / Llegá / Reservá"), que sobreescribían los defaults neutrales del
-- código. Los pasa a tuteo (igual que useLandingConfig). Visible en la landing
-- móvil y en el video de marketing. Va por migración (config del demo protegida).
-- ============================================================================

UPDATE tenants
SET config = jsonb_set(
      COALESCE(config, '{}'::jsonb),
      '{landing,post_hero,items}',
      '[
        {"titulo": "Elige tu plan", "texto": "Elige la membresía que va con tu ritmo. Sin permanencia rara, sin letra chica."},
        {"titulo": "Reserva desde la app", "texto": "Elige sala, día y horario en segundos. Sin llamadas, sin esperar."},
        {"titulo": "Llega y entrena", "texto": "Muestra tu QR en recepción y listo. Las salas ya están montadas con todo el equipo."}
      ]'::jsonb,
      true)
WHERE slug = 'healthyspace';
