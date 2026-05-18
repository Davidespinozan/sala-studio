-- ============================================================================
-- Sprint D-Admin · Funciones helper para validar hard delete
-- ============================================================================
-- Hard delete de recursos/tiers solo se permite cuando no hay FKs vinculadas.
-- Estas funciones cuentan las dependencias y son consumidas por el frontend
-- via supabase.rpc(...) antes de invocar DELETE FROM.
-- ============================================================================

CREATE OR REPLACE FUNCTION count_reservas_recurso(p_recurso_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM reservas WHERE recurso_id = p_recurso_id;
$$;

-- Cuenta miembros vinculados a un tier (cualquier estado).
-- Doble fuente:
--   1. membresias.tier_id (flow Stripe futuro)
--   2. usuarios.membresia_tier (slug, flow fake-signup actual)
-- DISTINCT user_id evita doble conteo.
CREATE OR REPLACE FUNCTION count_miembros_tier(p_tier_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(DISTINCT user_id) FROM (
    SELECT usuario_id AS user_id FROM membresias
      WHERE tier_id = p_tier_id
    UNION
    SELECT u.id AS user_id FROM usuarios u
      JOIN tiers t ON t.slug = u.membresia_tier
        AND t.tenant_id = u.tenant_id
      WHERE t.id = p_tier_id
  ) AS combined;
$$;

GRANT EXECUTE ON FUNCTION count_reservas_recurso(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION count_miembros_tier(uuid) TO authenticated;

COMMENT ON FUNCTION count_reservas_recurso IS
  'Sprint D-Admin: usado por hard delete guard. Bloquea DELETE FROM recursos si > 0.';

COMMENT ON FUNCTION count_miembros_tier IS
  'Sprint D-Admin: usado por hard delete guard. Bloquea DELETE FROM tiers si > 0. Doble fuente: membresias + usuarios.membresia_tier.';
