-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- PLAN CON VENTANA FIJA — vigencia por FECHAS de calendario (no "X días rodantes").
-- ────────────────────────────────────────────────────────────────────────────
-- Normalmente un plan vence a los `duracion_dias` DESDE que se activa (rodante).
-- Pero una PREVENTA es distinta: todos entran del 3-ago al 1-nov, la MISMA fecha
-- para todos, sin importar cuándo se inscribieron. Es una ventana fija.
--
-- Se agregan tiers.vigencia_inicio / vigencia_fin (opcionales). Si vigencia_fin
-- está puesta, la membresía de ese plan vence en esa fecha fija.
--
-- Cómo se aplica SIN tocar los RPCs de renovar (que son críticos): un trigger en
-- `membresias` que, al crear/actualizar, si el plan tiene ventana fija, sobrescribe
-- periodo_actual_fin (y _inicio) con las fechas del plan. Así funciona igual por
-- recepción, cobro online o importación — un solo lugar, sin reproducir 200 líneas
-- de lógica. Un plan SIN ventana (lo normal) no se toca: el trigger no hace nada.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE tiers
  ADD COLUMN IF NOT EXISTS vigencia_inicio date,
  ADD COLUMN IF NOT EXISTS vigencia_fin    date;

COMMENT ON COLUMN tiers.vigencia_fin IS
  'Ventana fija: si está puesta, toda membresía de este plan vence en ESTA fecha (calendario), no a los duracion_dias de la compra. Para preventas/promos con fecha de corte. NULL = vigencia rodante normal.';

-- ── Trigger: aplicar la ventana fija a la membresía ─────────────────────────
CREATE OR REPLACE FUNCTION aplicar_ventana_fija_membresia()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ini date;
  v_fin date;
BEGIN
  SELECT vigencia_inicio, vigencia_fin INTO v_ini, v_fin
  FROM tiers WHERE id = NEW.tier_id;

  IF v_fin IS NOT NULL THEN
    -- Fin de día para que el 1-nov cuente completo (hasta 23:59:59.999).
    NEW.periodo_actual_fin := (v_fin + 1)::timestamptz - interval '1 millisecond';
    IF v_ini IS NOT NULL THEN
      NEW.periodo_actual_inicio := v_ini::timestamptz;
    END IF;
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS membresias_ventana_fija ON membresias;
CREATE TRIGGER membresias_ventana_fija
  BEFORE INSERT OR UPDATE OF tier_id, periodo_actual_fin, periodo_actual_inicio ON membresias
  FOR EACH ROW EXECUTE FUNCTION aplicar_ventana_fija_membresia();

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — se auto-verifica: si el trigger NO aplica la ventana fija, ABORTA la
-- migración (RAISE). Si pasa, revierte los datos de prueba (savepoint). El SELECT
-- final devuelve TABLA confirmando columnas + trigger.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tenant uuid; v_socio uuid; v_tier uuid; v_mem_fin timestamptz;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE status = 'activo' ORDER BY created_at LIMIT 1;
  IF v_tenant IS NULL THEN
    RAISE NOTICE 'TEST SKIP: sin tenant activo.'; RETURN;
  END IF;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, 'ventana-test@example.com', 'Ventana Test', 'miembro', 'activo')
  RETURNING id INTO v_socio;

  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, vigencia_fin, activo, orden)
  VALUES (v_tenant, 'ventana-test', 'Ventana Test', 'tiempo', 100000, 'MXN', 30, DATE '2026-11-01', true, 999)
  RETURNING id INTO v_tier;

  -- Se inserta con fin "rodante" (hoy+30d) → el trigger debe pisarlo con la fecha
  -- fija del plan (1-nov, fin de día).
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
  VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now() + interval '30 days')
  RETURNING periodo_actual_fin INTO v_mem_fin;

  IF v_mem_fin::date <> DATE '2026-11-01' THEN
    RAISE EXCEPTION 'TEST FALLO: la ventana fija no se aplicó (fin quedó %, se esperaba 2026-11-01)', v_mem_fin;
  END IF;

  -- Éxito → revertir los datos de prueba.
  RAISE EXCEPTION 'ROLLBACK_OK_VENTANA';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'TEST FALLO%' THEN RAISE;            -- propagar el fallo: aborta la migración
  ELSIF SQLERRM = 'ROLLBACK_OK_VENTANA' THEN NULL;     -- pasó; datos de prueba revertidos
  ELSE RAISE;
  END IF;
END $$;

SELECT
  'columnas vigencia_inicio/fin existen' AS prueba,
  (SELECT count(*) FROM information_schema.columns
   WHERE table_name = 'tiers' AND column_name IN ('vigencia_inicio','vigencia_fin')) AS columnas_esperado_2,
  (SELECT count(*) FROM information_schema.triggers
   WHERE event_object_table = 'membresias' AND trigger_name = 'membresias_ventana_fija') AS trigger_esperado_1;
