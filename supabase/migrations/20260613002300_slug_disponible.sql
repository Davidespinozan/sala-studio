-- ============================================================================
-- FIX — chequeo de disponibilidad de slug (onboarding) seeing all states.
-- ----------------------------------------------------------------------------
-- El wizard chequeaba la disponibilidad del subdominio leyendo `tenants` como
-- anon, que por RLS solo ve tenants status='activo'. Un slug perteneciente a un
-- tenant suspendido/cancelado daba "Disponible" en verde y recién reventaba al
-- final del wizard (SLUG_TOMADO). Este RPC SECURITY DEFINER ve TODOS los estados.
-- ============================================================================

CREATE OR REPLACE FUNCTION slug_disponible(p_slug text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM tenants WHERE slug = lower(trim(p_slug))
  );
$$;

REVOKE ALL ON FUNCTION slug_disponible(text) FROM PUBLIC;
-- Público: el onboarding es pre-auth (anon).
GRANT EXECUTE ON FUNCTION slug_disponible(text) TO anon, authenticated;

COMMENT ON FUNCTION slug_disponible(text) IS
  'Onboarding: true si ningún tenant (de cualquier estado) usa ese slug. SECURITY DEFINER para no depender de la RLS (que solo expone activos a anon).';

-- ============================================================================
-- TEST — un slug existente da false; uno inventado da true.
-- ============================================================================
DO $$
DECLARE v_slug text; v_existe boolean; v_libre boolean;
BEGIN
  SELECT slug INTO v_slug FROM tenants LIMIT 1;
  IF v_slug IS NULL THEN RAISE NOTICE 'TEST SKIP: no hay tenants.'; RETURN; END IF;

  SELECT slug_disponible(v_slug) INTO v_existe;
  SELECT slug_disponible('zzz-no-existe-' || substr(gen_random_uuid()::text,1,8)) INTO v_libre;

  IF v_existe <> false THEN RAISE EXCEPTION 'TEST FALLO: un slug existente se reportó disponible.'; END IF;
  IF v_libre <> true THEN RAISE EXCEPTION 'TEST FALLO: un slug inventado se reportó tomado.'; END IF;

  RAISE NOTICE 'TEST OK: slug_disponible distingue tomado vs libre (todos los estados).';
END $$;
