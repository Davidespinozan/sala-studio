-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ════════════════════════════════════════════════════════════════════════════
-- RECONCILIAR CRÉDITOS al convertir un plan a "créditos" (bug de dinero de raíz)
-- ----------------------------------------------------------------------------
-- Bug real (The Core): una admin editó un plan de tipo 'tiempo' → 'creditos'
-- (paquete de clases). `gestionar_membresia_socio` otorga bien los créditos SEGÚN
-- el tipo del plan AL MOMENTO del cambio del socio, pero editar el TIER después es
-- un UPDATE directo a `tiers` que NO reconcilia a los socios que ya estaban en él:
-- se quedaron con `creditos_restantes = NULL` → el motor los trata como 0 →
-- SIN_CREDITOS pese a tener plan activo y vigente.
--
-- Fix: trigger AFTER UPDATE en `tiers`. Cuando el plan (ahora) es de créditos/híbrido
-- con paquete > 0 y cambió su tipo o el tamaño del paquete, otorga `clases_incluidas`
-- a los socios activos de ese tier que tengan `creditos_restantes = NULL` (los que
-- venían de un plan por tiempo o nunca se inicializaron). NO re-regala a quien ya
-- tiene saldo o lo gastó (0). Registra el movimiento en el ledger cuando hay actor.
--
-- Nada retroactivo raro: solo toca filas en NULL, así es idempotente por socio.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION reconciliar_creditos_por_cambio_tier()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();  -- NULL si el UPDATE viene de service_role/SQL
BEGIN
  -- Solo planes que (ahora) son de créditos/híbrido con paquete definido.
  IF NEW.tipo NOT IN ('creditos','hibrido') THEN RETURN NEW; END IF;
  IF COALESCE(NEW.clases_incluidas, 0) <= 0 THEN RETURN NEW; END IF;
  -- Solo si cambió el tipo o el tamaño del paquete (no en cada edición del plan).
  IF OLD.tipo IS NOT DISTINCT FROM NEW.tipo
     AND OLD.clases_incluidas IS NOT DISTINCT FROM NEW.clases_incluidas THEN
    RETURN NEW;
  END IF;

  -- Ledger: registrar el otorgamiento (solo si hay actor; created_by puede ser
  -- NOT NULL). El UPDATE de créditos se hace igual aunque no haya actor.
  IF v_actor IS NOT NULL THEN
    INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by)
    SELECT m.id, m.tenant_id, 'alta', NEW.clases_incluidas, NULL,
           format('créditos otorgados por reconfiguración del plan a %s clase(s) (tier %s)',
                  NEW.clases_incluidas, NEW.slug),
           v_actor
    FROM membresias m
    WHERE m.tier_id = NEW.id
      AND m.status IN ('trialing','activa','past_due','congelada')
      AND m.creditos_restantes IS NULL;
  END IF;

  UPDATE membresias m
  SET creditos_restantes = NEW.clases_incluidas,
      updated_at = now()
  WHERE m.tier_id = NEW.id
    AND m.status IN ('trialing','activa','past_due','congelada')
    AND m.creditos_restantes IS NULL;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS tiers_reconciliar_creditos ON tiers;
CREATE TRIGGER tiers_reconciliar_creditos
  AFTER UPDATE ON tiers
  FOR EACH ROW EXECUTE FUNCTION reconciliar_creditos_por_cambio_tier();

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — se auto-verifica y REVIERTE (sentinel). El SELECT final devuelve TABLA.
--   1) socio en plan por tiempo (creditos NULL) + el plan pasa a créditos(40)
--      → el socio queda con 40.
--   2) socio con saldo (5) en el mismo tier NO se toca (sigue con 5).
--   3) socio con 0 (paquete gastado) NO se re-regala (sigue en 0).
-- (En la migración get_my_user_id() es NULL → no se insertan movimientos; el test
--  valida el saldo, que es lo que importa.)
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tenant uuid; v_tier uuid;
  v_s_null uuid; v_s_saldo uuid; v_s_cero uuid;
  v_m_null uuid; v_m_saldo uuid; v_m_cero uuid;
  v_null int := -1; v_saldo int := -1; v_cero int := -1;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE status='activo' ORDER BY created_at LIMIT 1;
  IF v_tenant IS NULL THEN RAISE NOTICE 'TEST SKIP: sin tenant.'; RETURN; END IF;

  -- Plan de prueba, arranca como 'tiempo' (sin créditos).
  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, activo, orden)
  VALUES (v_tenant, 'reconc-test', 'Reconc Test', 'tiempo', 100000, 'MXN', 30, true, 999)
  RETURNING id INTO v_tier;

  -- 3 socios en ese plan: uno con crédito NULL, uno con 5, uno con 0.
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant,'reconc-null@example.com','Reconc Null','miembro','activo') RETURNING id INTO v_s_null;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant,'reconc-saldo@example.com','Reconc Saldo','miembro','activo') RETURNING id INTO v_s_saldo;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant,'reconc-cero@example.com','Reconc Cero','miembro','activo') RETURNING id INTO v_s_cero;

  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
  VALUES (v_tenant, v_s_null, v_tier, 'activa', now(), now()+interval '30 days', NULL) RETURNING id INTO v_m_null;
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
  VALUES (v_tenant, v_s_saldo, v_tier, 'activa', now(), now()+interval '30 days', 5) RETURNING id INTO v_m_saldo;
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
  VALUES (v_tenant, v_s_cero, v_tier, 'activa', now(), now()+interval '30 days', 0) RETURNING id INTO v_m_cero;

  -- El disparo: el plan pasa a créditos con paquete de 40.
  UPDATE tiers SET tipo='creditos', clases_incluidas=40 WHERE id = v_tier;

  SELECT creditos_restantes INTO v_null  FROM membresias WHERE id = v_m_null;
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_m_saldo;
  SELECT creditos_restantes INTO v_cero  FROM membresias WHERE id = v_m_cero;

  IF v_null IS DISTINCT FROM 40 THEN RAISE EXCEPTION 'TEST FALLO: NULL no quedó en 40 (=%).', v_null; END IF;
  IF v_saldo IS DISTINCT FROM 5 THEN RAISE EXCEPTION 'TEST FALLO: se pisó el saldo de 5 (=%).', v_saldo; END IF;
  IF v_cero  IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'TEST FALLO: se re-regaló al de 0 (=%).', v_cero; END IF;

  RAISE EXCEPTION 'ROLLBACK_RECONC_OK';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'TEST FALLO%' THEN RAISE;
  ELSIF SQLERRM = 'ROLLBACK_RECONC_OK' THEN NULL;
  ELSE RAISE;
  END IF;
END $$;

SELECT
  'reconciliar créditos al convertir plan a créditos' AS prueba,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'reconciliar_creditos_por_cambio_tier') AS funcion_ok,
  (SELECT count(*) FROM information_schema.triggers
   WHERE event_object_table='tiers' AND trigger_name='tiers_reconciliar_creditos') AS trigger_ok;
