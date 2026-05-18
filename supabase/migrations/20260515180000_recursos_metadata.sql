-- ============================================================================
-- Recursos: metadata para página de Estudios
-- ============================================================================

ALTER TABLE recursos
  ADD COLUMN IF NOT EXISTS equipo_incluido text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tipo_contenido text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS estilo_visual text,
  ADD COLUMN IF NOT EXISTS capacidad_personas integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS foto_url text;

COMMENT ON COLUMN recursos.equipo_incluido IS
  'Lista del equipo profesional disponible en el estudio.';
COMMENT ON COLUMN recursos.tipo_contenido IS
  'Tipos de contenido recomendados (Podcast, Video, etc.)';
COMMENT ON COLUMN recursos.estilo_visual IS
  'Descripción cualitativa del estilo visual del estudio.';
COMMENT ON COLUMN recursos.capacidad_personas IS
  'Capacidad máxima total (titular + invitados).';
COMMENT ON COLUMN recursos.foto_url IS
  'URL pública de la foto principal del estudio (Supabase Storage).';

-- Seed para los 3 estudios existentes en tenant 'ekko'
UPDATE recursos
SET
  equipo_incluido = ARRAY[
    'Cámara Sony A7 IV',
    'Micrófono Shure SM7B',
    'Iluminación LED profesional',
    'Pantalla verde opcional',
    'Audio Interface'
  ],
  tipo_contenido = ARRAY['Podcast', 'Video', 'Entrevistas'],
  estilo_visual = 'Iluminación cálida, fondo neutro madera, atmósfera profesional pero accesible.',
  capacidad_personas = 3
WHERE slug = 'estudio-1'
  AND tenant_id = (SELECT id FROM tenants WHERE slug = 'ekko');

UPDATE recursos
SET
  equipo_incluido = ARRAY[
    'Cámara Sony A7 IV',
    'Micrófono Rode NT-USB',
    'Iluminación LED ajustable',
    'Audio Interface',
    'Trípode profesional'
  ],
  tipo_contenido = ARRAY['Video', 'Cursos', 'Tutoriales'],
  estilo_visual = 'Espacio versátil con fondo intercambiable, ideal para contenido educativo y reviews.',
  capacidad_personas = 3
WHERE slug = 'estudio-2'
  AND tenant_id = (SELECT id FROM tenants WHERE slug = 'ekko');

-- NOTA: el slug real del tercer estudio es 'black' (no 'estudio-black'),
-- según la migración 003_recursos.sql que hizo el seed inicial.
UPDATE recursos
SET
  equipo_incluido = ARRAY[
    'Cámaras Cinema 4K',
    'Set completo de iluminación cinematográfica',
    'Micrófonos profesionales (Shure SM7B + Rode lavalier)',
    'Pantalla LED grande',
    'Mesa de mezclas',
    'Asistencia técnica incluida'
  ],
  tipo_contenido = ARRAY['Producciones', 'Cinema', 'Comerciales', 'Música videos'],
  estilo_visual = 'Estudio premium con estética cinematográfica. Iluminación dramática controlable. Diseñado para producciones de alto nivel.',
  capacidad_personas = 5
WHERE slug = 'black'
  AND tenant_id = (SELECT id FROM tenants WHERE slug = 'ekko');
