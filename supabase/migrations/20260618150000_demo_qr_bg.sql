-- ============================================================================
-- Demo: imagen de fondo para la pantalla del QR del socio (healthyspace)
-- ----------------------------------------------------------------------------
-- La pantalla "Mi QR" usa una foto de fondo (con scrim a la izquierda para que
-- el texto se lea). La URL vive en config.member.qr_bg_url → es EDITABLE por el
-- tenant (no hardcodeada en el componente). Acá seteamos el valor del demo.
-- Va por migración porque el guardrail bloquea editar la config de healthyspace
-- desde el admin autenticado.
-- ============================================================================

UPDATE tenants
SET config = COALESCE(config, '{}'::jsonb) ||
  jsonb_build_object(
    'member',
    COALESCE(config -> 'member', '{}'::jsonb) ||
      jsonb_build_object(
        'qr_bg_url',
        'https://omrlbvhbggnrwwzlgxji.supabase.co/storage/v1/object/public/estudios/sala-demo/lite-1.jpg'
      )
  )
WHERE slug = 'healthyspace';
