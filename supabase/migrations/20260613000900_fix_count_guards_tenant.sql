-- ============================================================================
-- FIX (menor) — count_reservas_recurso / count_miembros_tier no validaban tenant.
-- ----------------------------------------------------------------------------
-- Ambas son SECURITY DEFINER y GRANT a authenticated, pero contaban por
-- recurso_id/tier_id sin verificar que el objeto sea del tenant del caller →
-- cualquier autenticado podía pasar un id ajeno y obtener un conteo de otro
-- gimnasio. Fuga de un número (no de datos), pero es sobre-alcance cross-tenant.
--
-- Fix: si el recurso/tier NO pertenece a get_my_tenant_id(), devolver 0.
-- ============================================================================

CREATE OR REPLACE FUNCTION count_reservas_recurso(p_recurso_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM recursos
      WHERE id = p_recurso_id AND tenant_id = get_my_tenant_id()
    )
    THEN (SELECT count(*) FROM reservas WHERE recurso_id = p_recurso_id)
    ELSE 0
  END;
$$;

CREATE OR REPLACE FUNCTION count_miembros_tier(p_tier_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM tiers
      WHERE id = p_tier_id AND tenant_id = get_my_tenant_id()
    )
    THEN (
      SELECT count(DISTINCT user_id) FROM (
        SELECT usuario_id AS user_id FROM membresias
          WHERE tier_id = p_tier_id
        UNION
        SELECT u.id AS user_id FROM usuarios u
          JOIN tiers t ON t.slug = u.membresia_tier
            AND t.tenant_id = u.tenant_id
          WHERE t.id = p_tier_id
      ) AS combined
    )
    ELSE 0
  END;
$$;

GRANT EXECUTE ON FUNCTION count_reservas_recurso(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION count_miembros_tier(uuid) TO authenticated;

-- ============================================================================
-- TEST — un tier/recurso de OTRO tenant devuelve 0 (no filtra el conteo real).
-- ============================================================================
DO $$
DECLARE
  v_recep uuid; v_recep_auth uuid; v_recep_tenant uuid;
  v_tier_otro uuid;
  v_count bigint;
BEGIN
  SELECT id, auth_id, tenant_id INTO v_recep, v_recep_auth, v_recep_tenant
  FROM usuarios WHERE rol IN ('recepcionista','admin') AND auth_id IS NOT NULL LIMIT 1;
  IF v_recep IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay staff con auth_id (el fix igual quedó aplicado).';
    RETURN;
  END IF;

  -- Un tier de OTRO tenant (si existe).
  SELECT id INTO v_tier_otro FROM tiers WHERE tenant_id <> v_recep_tenant LIMIT 1;
  IF v_tier_otro IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay tiers de otro tenant para comparar.';
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_recep_auth::text)::text, true);
  SELECT count_miembros_tier(v_tier_otro) INTO v_count;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'TEST FALLO: count_miembros_tier de otro tenant devolvió % (esperaba 0).', v_count;
  END IF;

  RAISE NOTICE 'TEST OK: count_* de un objeto de otro tenant devuelve 0.';
END $$;
