-- ============================================================================
-- S6 — Instructores como entidad propia
-- ============================================================================
-- Reemplaza el mock `clases.instructor_nombre_mock` por una tabla real de
-- instructores que el admin gestiona como fichas. NO son usuarios con login.
--
-- Pasos:
--   A) CREATE TABLE instructores (+ índice, trigger, RLS)
--   B) Re-apuntar clases.instructor_id: FK pasa de usuarios → instructores
--   C) Marcar clases.instructor_nombre_mock como DEPRECATED (no se dropea)
--
-- Idempotente: CREATE ... IF NOT EXISTS, DROP POLICY IF EXISTS, DROP CONSTRAINT
-- IF EXISTS.
-- ============================================================================

-- ============================================================================
-- A) CREATE TABLE instructores
-- ============================================================================

CREATE TABLE IF NOT EXISTS instructores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  nombre text NOT NULL,
  bio text,
  foto_url text,
  especialidades text[] NOT NULL DEFAULT '{}',

  activo boolean NOT NULL DEFAULT true,
  orden integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_instructores_tenant
  ON instructores (tenant_id) WHERE activo = true;

DROP TRIGGER IF EXISTS instructores_set_updated_at ON instructores;
CREATE TRIGGER instructores_set_updated_at
  BEFORE UPDATE ON instructores
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE instructores ENABLE ROW LEVEL SECURITY;

-- RLS alineada con el patrón de `recursos`:
--   - authenticated lee los instructores de su tenant
--   - anon lee solo los activos (landing pública)
--   - admin gestiona los de su tenant
DROP POLICY IF EXISTS instructores_read_tenant ON instructores;
CREATE POLICY instructores_read_tenant ON instructores
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id());

DROP POLICY IF EXISTS instructores_read_public ON instructores;
CREATE POLICY instructores_read_public ON instructores
  FOR SELECT
  TO anon
  USING (activo = true);

DROP POLICY IF EXISTS instructores_admin_all ON instructores;
CREATE POLICY instructores_admin_all ON instructores
  FOR ALL
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

COMMENT ON TABLE instructores IS
  'S6: instructores del tenant como entidad propia (sin login). El admin los gestiona como fichas y los asigna a clases vía clases.instructor_id.';
COMMENT ON COLUMN instructores.especialidades IS
  'Tags de disciplinas que dicta el instructor (ej. Yoga, Spinning).';

-- ============================================================================
-- B) Re-apuntar clases.instructor_id: usuarios → instructores
-- ============================================================================
-- La columna instructor_id se creó en S4.1 como FK a usuarios. Ninguna clase
-- generada la populó (siempre NULL), así que cambiar el destino del FK es
-- seguro: no hay filas que violen el constraint nuevo.

ALTER TABLE clases DROP CONSTRAINT IF EXISTS clases_instructor_id_fkey;
ALTER TABLE clases ADD CONSTRAINT clases_instructor_id_fkey
  FOREIGN KEY (instructor_id) REFERENCES instructores(id) ON DELETE SET NULL;

-- ============================================================================
-- C) Deprecar instructor_nombre_mock (no se dropea todavía)
-- ============================================================================

COMMENT ON COLUMN clases.instructor_nombre_mock IS
  'DEPRECATED (S6): usar instructor_id FK a instructores. Mantener hasta migrar datos.';
