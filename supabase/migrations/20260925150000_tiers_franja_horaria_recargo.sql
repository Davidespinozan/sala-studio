-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ════════════════════════════════════════════════════════════════════════════
-- FRANJA HORARIA DE ACCESO POR PLAN (+ recargo por reservar fuera)
-- ----------------------------------------------------------------------------
-- Caso numa (Plan Promo): el socio solo puede reservar en cierta franja (ej.
-- 16:00–17:00). Puede reservar FUERA pagando un recargo que se cobra en recepción.
--
-- Espejo exacto de `dias_acceso` (20260727160000) pero sobre la HORA del día, y
-- reusa la plomería de multa (20260806170000): el recargo se estampa en
-- reservas.multa_centavos y recepción lo cobra con la UI de multas pendientes que
-- ya existe. El monto vive en el PLAN (no en config del tenant) porque el recargo
-- es intrínseco al plan promo, no una política del gym.
--
-- Enforcement por TRIGGER BEFORE INSERT en `reservas` (como dias_acceso), no en el
-- RPC. El flag por transacción `sala.acepta_multa='on'` (que ya ponen los wrappers
-- _con_multa) indica que el socio aceptó el recargo.
--
-- Aditivo: un plan sin franja (hora_acceso_inicio/fin NULL) no cambia en nada.
-- ════════════════════════════════════════════════════════════════════════════

-- 1) Esquema: franja + recargo en el plan.
ALTER TABLE tiers
  ADD COLUMN IF NOT EXISTS hora_acceso_inicio time,
  ADD COLUMN IF NOT EXISTS hora_acceso_fin    time,
  ADD COLUMN IF NOT EXISTS recargo_fuera_franja_centavos int NOT NULL DEFAULT 0;

ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_franja_valida;
ALTER TABLE tiers ADD CONSTRAINT tiers_franja_valida CHECK (
  (hora_acceso_inicio IS NULL AND hora_acceso_fin IS NULL)
  OR (hora_acceso_inicio IS NOT NULL AND hora_acceso_fin IS NOT NULL
      AND hora_acceso_inicio < hora_acceso_fin)
);

ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_recargo_franja_valido;
ALTER TABLE tiers ADD CONSTRAINT tiers_recargo_franja_valido
  CHECK (recargo_fuera_franja_centavos >= 0);

COMMENT ON COLUMN tiers.hora_acceso_inicio IS
  'Franja horaria en que este plan puede reservar (inicio, hora local del gym). NULL = sin restricción de hora.';
COMMENT ON COLUMN tiers.hora_acceso_fin IS
  'Fin de la franja (exclusivo: una clase que empieza justo a esta hora ya queda fuera).';
COMMENT ON COLUMN tiers.recargo_fuera_franja_centavos IS
  'Recargo por reservar FUERA de la franja (se estampa en reservas.multa_centavos y lo cobra recepción). 0 = fuera de franja se bloquea sin opción de pagar.';

-- 2) Trigger: enforce la franja leyendo slot_inicio en la TZ del gym.
--    Corre DESPUÉS de reservas_limite_diario (nombre 'reservas_recargo_franja' >
--    'reservas_limite_diario' alfabéticamente) para SUMAR el recargo sobre una
--    multa de no-show ya estampada, en vez de pisarla.
CREATE OR REPLACE FUNCTION verificar_franja_acceso_reserva()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ini time;
  v_fin time;
  v_recargo int;
  v_tz text;
  v_hora time;
  v_acepta boolean;
BEGIN
  -- Franja + recargo del plan ACTIVO del socio.
  SELECT t.hora_acceso_inicio, t.hora_acceso_fin, COALESCE(t.recargo_fuera_franja_centavos, 0)
  INTO v_ini, v_fin, v_recargo
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = NEW.usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
  ORDER BY m.created_at DESC
  LIMIT 1;

  -- Sin plan, o plan sin franja → cualquier hora.
  IF v_ini IS NULL OR v_fin IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(config->>'timezone', 'America/Mexico_City') INTO v_tz
  FROM tenants WHERE id = NEW.tenant_id;

  v_hora := (NEW.slot_inicio AT TIME ZONE v_tz)::time;

  -- Dentro de la franja [inicio, fin) → OK.
  IF v_hora >= v_ini AND v_hora < v_fin THEN
    RETURN NEW;
  END IF;

  -- Fuera de la franja.
  IF v_recargo <= 0 THEN
    -- Sin recargo configurado → bloqueo duro (el plan solo reserva en su franja).
    RAISE EXCEPTION 'FRANJA_NO_PERMITIDA: Tu plan solo permite reservar de % a %',
      to_char(v_ini, 'HH24:MI'), to_char(v_fin, 'HH24:MI');
  END IF;

  -- ¿El socio aceptó el recargo? (flag por transacción que ponen los wrappers _con_multa)
  v_acepta := COALESCE(current_setting('sala.acepta_multa', true), '') = 'on';
  IF NOT v_acepta THEN
    -- Señal para la app: falta confirmar el recargo. El monto (centavos) va en el mensaje.
    RAISE EXCEPTION 'RECARGO_FRANJA: %', v_recargo;
  END IF;

  -- Aceptó → SUMA el recargo (no pisa una multa de no-show ya estampada por otro trigger).
  NEW.multa_centavos := COALESCE(NEW.multa_centavos, 0) + v_recargo;
  NEW.multa_pagada := false;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS reservas_recargo_franja ON reservas;
CREATE TRIGGER reservas_recargo_franja
  BEFORE INSERT ON reservas
  FOR EACH ROW EXECUTE FUNCTION verificar_franja_acceso_reserva();

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — se auto-verifica y REVIERTE (sentinel). Prueba el corazón del trigger:
--   1) fuera de franja, recargo>0, sin aceptar → RECARGO_FRANJA.
--   2) fuera de franja, recargo>0, aceptado    → permite y estampa el recargo.
--   3) dentro de franja                        → permite sin recargo.
--   4) fuera de franja, recargo=0              → FRANJA_NO_PERMITIDA (bloqueo duro).
-- Si algo falla, RAISE 'TEST FALLO' aborta la migración (visible). El SELECT final
-- devuelve TABLA con los chequeos de esquema/trigger.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tenant uuid; v_socio uuid; v_tier uuid; v_recurso uuid; v_tz text;
  v_dia date; v_out timestamptz; v_in timestamptz; v_out2 timestamptz;
  v_multa int := -1;
  v_ok1 boolean := false; v_ok2 boolean := false; v_ok3 boolean := false; v_ok4 boolean := false;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE status='activo' ORDER BY created_at LIMIT 1;
  IF v_tenant IS NULL THEN RAISE NOTICE 'TEST SKIP: sin tenant.'; RETURN; END IF;
  SELECT id INTO v_recurso FROM recursos WHERE tenant_id = v_tenant LIMIT 1;
  IF v_recurso IS NULL THEN RAISE NOTICE 'TEST SKIP: sin recurso.'; RETURN; END IF;
  v_tz := COALESCE((SELECT config->>'timezone' FROM tenants WHERE id=v_tenant), 'America/Mexico_City');

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, 'franja-test@example.com', 'Franja Test', 'miembro', 'activo')
  RETURNING id INTO v_socio;

  -- Plan con franja 16:00–17:00 y recargo $50.
  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias,
                     hora_acceso_inicio, hora_acceso_fin, recargo_fuera_franja_centavos, activo, orden)
  VALUES (v_tenant, 'franja-test', 'Franja Test', 'tiempo', 100000, 'MXN', 30,
          time '16:00', time '17:00', 5000, true, 999)
  RETURNING id INTO v_tier;

  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
  VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now() + interval '30 days');

  v_dia  := (now() AT TIME ZONE v_tz)::date + 3;
  v_out  := (v_dia + time '12:00') AT TIME ZONE v_tz;   -- fuera (mañana)
  v_in   := (v_dia + time '16:30') AT TIME ZONE v_tz;   -- dentro
  v_out2 := (v_dia + time '19:00') AT TIME ZONE v_tz;   -- fuera (noche)

  -- (1) fuera + recargo>0 + sin aceptar → RECARGO_FRANJA
  PERFORM set_config('sala.acepta_multa', 'off', true);
  BEGIN
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status)
    VALUES (v_tenant, v_recurso, v_socio, v_out, v_out + interval '1 hour', 60, 'TEST-FRJ-1', 'confirmada');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'RECARGO_FRANJA%' THEN v_ok1 := true; ELSE RAISE; END IF;
  END;

  -- (2) fuera + aceptado → estampa el recargo (5000)
  PERFORM set_config('sala.acepta_multa', 'on', true);
  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status)
  VALUES (v_tenant, v_recurso, v_socio, v_out, v_out + interval '1 hour', 60, 'TEST-FRJ-2', 'confirmada')
  RETURNING multa_centavos INTO v_multa;
  v_ok2 := (v_multa = 5000);

  -- (3) dentro de franja → permite sin recargo
  PERFORM set_config('sala.acepta_multa', 'off', true);
  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status)
  VALUES (v_tenant, v_recurso, v_socio, v_in, v_in + interval '1 hour', 60, 'TEST-FRJ-3', 'confirmada')
  RETURNING multa_centavos INTO v_multa;
  v_ok3 := (v_multa = 0);

  -- (4) recargo=0 + fuera → bloqueo duro FRANJA_NO_PERMITIDA
  UPDATE tiers SET recargo_fuera_franja_centavos = 0 WHERE id = v_tier;
  BEGIN
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status)
    VALUES (v_tenant, v_recurso, v_socio, v_out2, v_out2 + interval '1 hour', 60, 'TEST-FRJ-4', 'confirmada');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FRANJA_NO_PERMITIDA%' THEN v_ok4 := true; ELSE RAISE; END IF;
  END;

  IF NOT v_ok1 THEN RAISE EXCEPTION 'TEST FALLO: no pidió RECARGO_FRANJA fuera de franja.'; END IF;
  IF NOT v_ok2 THEN RAISE EXCEPTION 'TEST FALLO: no estampó el recargo (multa_centavos=%).', v_multa; END IF;
  IF NOT v_ok3 THEN RAISE EXCEPTION 'TEST FALLO: cobró recargo DENTRO de la franja (multa_centavos=%).', v_multa; END IF;
  IF NOT v_ok4 THEN RAISE EXCEPTION 'TEST FALLO: no bloqueó con recargo=0.'; END IF;

  RAISE EXCEPTION 'ROLLBACK_FRANJA_OK';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'TEST FALLO%' THEN RAISE;
  ELSIF SQLERRM = 'ROLLBACK_FRANJA_OK' THEN NULL;
  ELSE RAISE;
  END IF;
END $$;

SELECT
  'franja horaria + recargo' AS prueba,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='tiers' AND column_name='hora_acceso_inicio')            AS col_inicio_ok,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='tiers' AND column_name='hora_acceso_fin')               AS col_fin_ok,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='tiers' AND column_name='recargo_fuera_franja_centavos') AS col_recargo_ok,
  (SELECT count(*) FROM information_schema.triggers
   WHERE event_object_table='reservas' AND trigger_name='reservas_recargo_franja')  AS trigger_ok;
