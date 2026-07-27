-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- ACCESO POR DÍA DE LA SEMANA (por plan) — ej. Elevate lun-vie, Ultra lun-sáb.
-- ────────────────────────────────────────────────────────────────────────────
-- Un plan puede limitar en qué días de la semana su socio puede reservar. numa:
-- Elevate = lun a vie, Ultra = lun a sáb. Hoy no se validaba; se agrega.
--
-- tiers.dias_acceso int[] con los días permitidos (0=domingo … 6=sábado, igual
-- que horarios_recurrentes.dias_semana). NULL o vacío = TODOS los días (sin
-- restricción; los planes actuales no cambian).
--
-- Se hace cumplir con un trigger BEFORE INSERT en `reservas` (la reserva ya trae
-- slot_inicio): si el plan del socio restringe días y la clase cae en un día NO
-- permitido, bloquea. El día se calcula en la ZONA HORARIA del gym (una clase de
-- sábado temprano no debe leerse como viernes en UTC). No toca el gate de reservar.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE tiers
  ADD COLUMN IF NOT EXISTS dias_acceso int[];

ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_dias_acceso_validos;
ALTER TABLE tiers ADD CONSTRAINT tiers_dias_acceso_validos
  CHECK (dias_acceso IS NULL OR dias_acceso <@ ARRAY[0,1,2,3,4,5,6]);

COMMENT ON COLUMN tiers.dias_acceso IS
  'Días de la semana en que el plan permite reservar (0=dom … 6=sáb, como horarios_recurrentes). NULL o vacío = todos los días. Ej.: lun-vie = {1,2,3,4,5}, lun-sáb = {1,2,3,4,5,6}.';

-- ── Trigger: bloquear la reserva si el día no está permitido por el plan ─────
CREATE OR REPLACE FUNCTION verificar_dia_acceso_reserva()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dias int[];
  v_tz text;
  v_dow int;
  v_nombre text;
BEGIN
  -- Días de acceso del plan ACTIVO del socio.
  SELECT t.dias_acceso INTO v_dias
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = NEW.usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
  ORDER BY m.created_at DESC
  LIMIT 1;

  -- Sin plan, o plan sin restricción → cualquier día.
  IF v_dias IS NULL OR cardinality(v_dias) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(config->>'timezone', 'America/Mexico_City') INTO v_tz
  FROM tenants WHERE id = NEW.tenant_id;

  v_dow := EXTRACT(DOW FROM (NEW.slot_inicio AT TIME ZONE v_tz))::int;

  IF NOT (v_dow = ANY(v_dias)) THEN
    v_nombre := CASE v_dow
      WHEN 0 THEN 'domingos' WHEN 1 THEN 'lunes'  WHEN 2 THEN 'martes'
      WHEN 3 THEN 'miércoles' WHEN 4 THEN 'jueves' WHEN 5 THEN 'viernes'
      WHEN 6 THEN 'sábados' END;
    RAISE EXCEPTION 'DIA_NO_PERMITIDO: Tu plan no incluye acceso los %', v_nombre;
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS reservas_dia_acceso ON reservas;
CREATE TRIGGER reservas_dia_acceso
  BEFORE INSERT ON reservas
  FOR EACH ROW EXECUTE FUNCTION verificar_dia_acceso_reserva();

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — se auto-verifica (aborta la migración si el bloqueo no funciona) y
-- revierte los datos de prueba. El SELECT final devuelve TABLA.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tenant uuid; v_socio uuid; v_tier uuid; v_recurso uuid; v_tz text;
  -- Próximo sábado a mediodía en la tz del gym (día NO permitido para lun-vie).
  v_sabado timestamptz; v_ok boolean := false;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE status = 'activo' ORDER BY created_at LIMIT 1;
  IF v_tenant IS NULL THEN RAISE NOTICE 'TEST SKIP: sin tenant activo.'; RETURN; END IF;
  SELECT id INTO v_recurso FROM recursos WHERE tenant_id = v_tenant LIMIT 1;
  IF v_recurso IS NULL THEN RAISE NOTICE 'TEST SKIP: sin recurso.'; RETURN; END IF;
  v_tz := COALESCE((SELECT config->>'timezone' FROM tenants WHERE id = v_tenant), 'America/Mexico_City');

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, 'dias-test@example.com', 'Días Test', 'miembro', 'activo')
  RETURNING id INTO v_socio;

  -- Plan lun-vie (sin sábados).
  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, dias_acceso, activo, orden)
  VALUES (v_tenant, 'dias-test', 'Días Test', 'tiempo', 100000, 'MXN', 30, ARRAY[1,2,3,4,5], true, 999)
  RETURNING id INTO v_tier;

  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
  VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now() + interval '30 days');

  -- Un sábado a mediodía local: buscamos el próximo sábado.
  v_sabado := ((date_trunc('week', (now() AT TIME ZONE v_tz)::date)::date + 5) + time '12:00') AT TIME ZONE v_tz;
  IF v_sabado <= now() THEN v_sabado := v_sabado + interval '7 days'; END IF;

  BEGIN
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status)
    VALUES (v_tenant, v_recurso, v_socio, v_sabado, v_sabado + interval '1 hour', 60, 'TEST-DIAS', 'confirmada');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'DIA_NO_PERMITIDO%' THEN v_ok := true; ELSE RAISE; END IF;
  END;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'TEST FALLO: un plan lun-vie dejó reservar en sábado.';
  END IF;

  RAISE EXCEPTION 'ROLLBACK_OK_DIAS';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'TEST FALLO%' THEN RAISE;
  ELSIF SQLERRM = 'ROLLBACK_OK_DIAS' THEN NULL;
  ELSE RAISE;
  END IF;
END $$;

SELECT
  'columna tiers.dias_acceso + trigger' AS prueba,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tiers' AND column_name='dias_acceso') AS columna_ok,
  (SELECT count(*) FROM information_schema.triggers
   WHERE event_object_table='reservas' AND trigger_name='reservas_dia_acceso') AS trigger_esperado_1;
