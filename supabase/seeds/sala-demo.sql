-- Tenant inicial demo para SALA Studio
-- Idempotente: usa ON CONFLICT en `slug` para no duplicar si ya existe.

INSERT INTO tenants (
  id,
  slug,
  nombre,
  config,
  branding
) VALUES (
  gen_random_uuid(),
  'sala-demo',
  'SALA Demo',
  jsonb_build_object(
    'landing', jsonb_build_object(
      'hero', jsonb_build_object(
        'titulo', 'Reserva tu próxima clase',
        'subtitulo', 'Yoga, Spinning, Crossfit y más en SALA Demo',
        'cta_text', 'Empieza ahora'
      ),
      'cta_final', jsonb_build_object(
        'titulo', '¿Listo para empezar?',
        'subtitulo', 'Reserva tu primera clase gratis',
        'cta_text', 'Crear cuenta'
      ),
      'footer', jsonb_build_object(
        'copy', '© SALA Demo. Todos los derechos reservados.'
      )
    ),
    'contacto', jsonb_build_object(
      'whatsapp_e164', '+521234567890',
      'email', 'demo@sala-studio.com'
    )
  ),
  jsonb_build_object(
    'logo_url_dark', null,
    'logo_url_light', null,
    'og_image_url', null,
    'favicon_url', null,
    'color_primary', '#e5b829',
    'color_accent', '#0a0a0a',
    'color_bg', '#0a0a0a'
  )
)
ON CONFLICT (slug) DO NOTHING;
