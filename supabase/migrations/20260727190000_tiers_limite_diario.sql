-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- MÁX. RESERVAS POR DÍA (por plan) — cuántas clases puede reservar un socio al día.
-- ────────────────────────────────────────────────────────────────────────────
-- Regla nueva por plan: un tope de reservas por día de calendario. NULL = sin
-- tope (planes actuales no cambian). Se hace cumplir con un trigger BEFORE INSERT
-- en `reservas` (como días de acceso): cuenta las reservas NO canceladas del socio
-- para ESE día (en la zona horaria del gym) y bloquea la que pase del tope. No
-- toca el gate crítico de reservar.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE tiers
  ADD COLUMN IF NOT EXISTS max_reservas_dia int;

ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_max_reservas_dia_valido;
ALTER TABLE tiers ADD CONSTRAINT tiers_max_reservas_dia_valido
  CHECK (max_reservas_dia IS NULL OR max_reservas_dia >= 1);

COMMENT ON COLUMN tiers.max_reservas_dia IS
  'Máximo de reservas por día de calendario para el socio de este plan. NULL = sin tope.';

-- ── Trigger: bloquear la reserva que pase del tope diario ───────────────────
CREATE OR REPLACE FUNCTION verificar_limite_diario_reserva()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max int;
  v_tz text;
  v_dia date;
  v_count int;
BEGIN
  SELECT t.max_reservas_dia INTO v_max
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = NEW.usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_max IS NULL OR v_max < 1 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(config->>'timezone', 'America/Mexico_City') INTO v_tz
  FROM tenants WHERE id = NEW.tenant_id;
  v_dia := (NEW.slot_inicio AT TIME ZONE v_tz)::date;

  -- Reservas vivas (no canceladas) del socio para ese mismo día.
  SELECT count(*) INTO v_count
  FROM reservas
  WHERE usuario_id = NEW.usuario_id
    AND status <> 'cancelada'
    AND (slot_inicio AT TIME ZONE v_tz)::date = v_dia;

  IF v_count >= v_max THEN
    RAISE EXCEPTION 'LIMITE_DIARIO: Tu plan permite % reserva(s) por día', v_max;
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS reservas_limite_diario ON reservas;
CREATE TRIGGER reservas_limite_diario
  BEFORE INSERT ON reservas
  FOR EACH ROW EXECUTE FUNCTION verificar_limite_diario_reserva();

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — se auto-verifica (la 2da reserva del día debe fallar con tope=1) y
-- revierte. SELECT final devuelve TABLA.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tenant uuid; v_socio uuid; v_tier uuid; v_recurso uuid; v_tz text;
  v_dia date; v_s1 timestamptz; v_s2 timestamptz; v_ok boolean := false;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE status='activo' ORDER BY created_at LIMIT 1;
  IF v_tenant IS NULL THEN RAISE NOTICE 'TEST SKIP: sin tenant.'; RETURN; END IF;
  SELECT id INTO v_recurso FROM recursos WHERE tenant_id = v_tenant LIMIT 1;
  IF v_recurso IS NULL THEN RAISE NOTICE 'TEST SKIP: sin recurso.'; RETURN; END IF;
  v_tz := COALESCE((SELECT config->>'timezone' FROM tenants WHERE id=v_tenant), 'America/Mexico_City');

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, 'limite-test@example.com', 'Límite Test', 'miembro', 'activo')
  RETURNING id INTO v_socio;

  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, max_reservas_dia, activo, orden)
  VALUES (v_tenant, 'limite-test', 'Límite Test', 'tiempo', 100000, 'MXN', 30, 1, true, 999)
  RETURNING id INTO v_tier;

  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
  VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now() + interval '30 days');

  v_dia := (now() AT TIME ZONE v_tz)::date + 2;
  v_s1 := (v_dia + time '10:00') AT TIME ZONE v_tz;
  v_s2 := (v_dia + time '11:00') AT TIME ZONE v_tz;

  -- 1ra reserva del día: pasa.
  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status)
  VALUES (v_tenant, v_recurso, v_socio, v_s1, v_s1 + interval '1 hour', 60, 'TEST-LIM-1', 'confirmada');

  -- 2da el mismo día: debe fallar.
  BEGIN
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status)
    VALUES (v_tenant, v_recurso, v_socio, v_s2, v_s2 + interval '1 hour', 60, 'TEST-LIM-2', 'confirmada');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'LIMITE_DIARIO%' THEN v_ok := true; ELSE RAISE; END IF;
  END;

  IF NOT v_ok THEN RAISE EXCEPTION 'TEST FALLO: dejó reservar 2 veces con tope 1.'; END IF;

  RAISE EXCEPTION 'ROLLBACK_OK_LIMITE';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'TEST FALLO%' THEN RAISE;
  ELSIF SQLERRM = 'ROLLBACK_OK_LIMITE' THEN NULL;
  ELSE RAISE;
  END IF;
END $$;

SELECT
  'columna tiers.max_reservas_dia + trigger' AS prueba,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tiers' AND column_name='max_reservas_dia') AS columna_ok,
  (SELECT count(*) FROM information_schema.triggers
   WHERE event_object_table='reservas' AND trigger_name='reservas_limite_diario') AS trigger_esperado_1;
