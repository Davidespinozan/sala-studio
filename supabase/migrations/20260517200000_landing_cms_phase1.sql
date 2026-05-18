-- ============================================================================
-- Sprint C1: CMS Landing fase 1
-- ============================================================================
-- Agrega bloques editables al tenant.config:
--   config.landing.hero       — copy del hero (eyebrow, título, subtítulo, CTA)
--   config.landing.cta_final  — copy del CTA de cierre antes del footer
--   config.landing.footer     — copy + redes + datos de contacto del footer
--   config.contacto           — WhatsApp E.164 + mensaje default (centralizado)
--
-- Hecho con `config || jsonb_build_object(...)` para no destruir las claves
-- ya existentes (reserva, penalizaciones, membresia, acceso, ui).
-- ============================================================================

UPDATE tenants
SET config = config
  || jsonb_build_object(
    'contacto', jsonb_build_object(
      'whatsapp_e164', '5216671234567',
      'whatsapp_mensaje_default', 'Hola, me interesa saber más sobre EKKO Studio.'
    ),
    'landing', jsonb_build_object(
      'hero', jsonb_build_object(
        'eyebrow', 'EKKO STUDIO · CULIACÁN',
        'titulo', 'Tu estudio. Tu contenido.',
        'titulo_accent', 'Sin límites.',
        'subtitulo', 'La plataforma para creadores que quieren grabar, crear y crecer al siguiente nivel. Equipo profesional, espacios diseñados y horas ilimitadas según tu membresía.',
        'cta_texto', 'Ver membresías →',
        'cta_link', '#membresias'
      ),
      'cta_final', jsonb_build_object(
        'eyebrow', 'CULIACÁN · MÉXICO',
        'titulo', '¿Listo para llevar tu contenido al siguiente nivel?',
        'subtitulo', 'Agenda una visita sin compromiso. Te mostramos los estudios y te ayudamos a elegir tu membresía.',
        'cta_texto', 'Contáctanos por WhatsApp →'
      ),
      'footer', jsonb_build_object(
        'tagline', 'STUDIO · CULIACÁN',
        'copyright', 'Todos los derechos reservados.',
        'direccion', NULL,
        'email', NULL,
        'redes', jsonb_build_object(
          'instagram', NULL,
          'tiktok', NULL,
          'youtube', NULL,
          'facebook', NULL
        )
      )
    )
  )
WHERE slug = 'ekko';

COMMENT ON COLUMN tenants.config IS
  'jsonb config por tenant. Bloques: reserva, penalizaciones, membresia, acceso, ui, contacto, landing.';
