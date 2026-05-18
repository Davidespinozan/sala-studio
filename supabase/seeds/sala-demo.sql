-- Tenant inicial demo para SALA Studio
-- Idempotente: usa ON CONFLICT en `slug` para no duplicar si ya existe.
--
-- Estructura del JSON alineada con la migración landing_cms_phase1
-- (claves esperadas por el CMS: hero.eyebrow/titulo/titulo_accent/cta_texto/cta_link,
--  cta_final.eyebrow/titulo/cta_texto, footer.tagline/copyright/direccion/email/redes,
--  contacto.whatsapp_e164/whatsapp_mensaje_default).

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
        'eyebrow', 'SALA DEMO · GIMNASIO',
        'titulo', 'Reserva tu próxima clase.',
        'titulo_accent', 'Sin esperas.',
        'subtitulo', 'Yoga, Spinning, Crossfit y más en SALA Demo. Equipo profesional, horarios flexibles y reserva en segundos.',
        'cta_texto', 'Empieza ahora →',
        'cta_link', '#membresias'
      ),
      'cta_final', jsonb_build_object(
        'eyebrow', 'DEMO · GIMNASIO',
        'titulo', '¿Listo para entrenar?',
        'subtitulo', 'Reserva tu primera clase gratis. Te mostramos las instalaciones y te ayudamos a elegir tu membresía.',
        'cta_texto', 'Crear cuenta →'
      ),
      'footer', jsonb_build_object(
        'tagline', 'DEMO · GIMNASIO',
        'copyright', '© SALA Demo. Todos los derechos reservados.',
        'direccion', NULL,
        'email', 'demo@sala-studio.com',
        'redes', jsonb_build_object(
          'instagram', NULL,
          'tiktok', NULL,
          'youtube', NULL,
          'facebook', NULL
        )
      )
    ),
    'contacto', jsonb_build_object(
      'whatsapp_e164', '+521234567890',
      'whatsapp_mensaje_default', 'Hola, me interesa saber más sobre SALA Demo.'
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
