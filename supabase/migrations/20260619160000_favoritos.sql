-- ============================================================================
-- FAVORITAS del socio — tabla `favoritos`.
-- ----------------------------------------------------------------------------
-- El socio marca SALAS/DISCIPLINAS (recursos) como favoritas. Elegimos el
-- RECURSO (no la clase) porque las clases son virtuales (expandir_clases) y no
-- tienen id estable; el recurso sí, y es lo que el socio reconoce ("mi Cycling").
--
-- Dato del PROPIO socio (no del tenant) → no se administra desde el panel; se
-- togglea desde la app del miembro (corazón en Salas / Detalle). RLS: cada socio
-- ve/edita solo lo suyo, vía get_my_user_id() (mismo helper que el resto).
-- ============================================================================

CREATE TABLE IF NOT EXISTS favoritos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  recurso_id uuid NOT NULL REFERENCES recursos(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (usuario_id, recurso_id)
);

CREATE INDEX IF NOT EXISTS favoritos_usuario_idx ON favoritos (usuario_id);

ALTER TABLE favoritos ENABLE ROW LEVEL SECURITY;

-- El socio LEE solo sus favoritos.
DROP POLICY IF EXISTS favoritos_read_self ON favoritos;
CREATE POLICY favoritos_read_self ON favoritos
  FOR SELECT TO authenticated
  USING (usuario_id = get_my_user_id());

-- El socio AGREGA un favorito propio, dentro de su tenant.
DROP POLICY IF EXISTS favoritos_insert_self ON favoritos;
CREATE POLICY favoritos_insert_self ON favoritos
  FOR INSERT TO authenticated
  WITH CHECK (usuario_id = get_my_user_id() AND tenant_id = get_my_tenant_id());

-- El socio QUITA un favorito propio.
DROP POLICY IF EXISTS favoritos_delete_self ON favoritos;
CREATE POLICY favoritos_delete_self ON favoritos
  FOR DELETE TO authenticated
  USING (usuario_id = get_my_user_id());

GRANT SELECT, INSERT, DELETE ON favoritos TO authenticated;

COMMENT ON TABLE favoritos IS
  'Salas/disciplinas (recursos) que un socio marcó como favoritas. Dato del socio; toggle desde la app del miembro. RLS self-scoped por get_my_user_id().';
