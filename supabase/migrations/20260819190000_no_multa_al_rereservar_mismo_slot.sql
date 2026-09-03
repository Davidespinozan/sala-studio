-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Re-reservar el MISMO horario que cancelaste NO cobra multa
-- ----------------------------------------------------------------------------
-- BUG (caso Nayaysin, reportado por numa): reservó una clase de las 23:00, la
-- canceló 28 min antes (tarde, ventana 1h) y volvió a reservar LA MISMA clase de
-- las 23:00 tres minutos después — y asistió (check-in). El sistema le puso la multa
-- de "re-reservar tras cancelar tarde" (Modelo A), tratando la re-reserva como si
-- fuera "otra" clase el mismo día.
--
-- Pero re-reservar el MISMO horario que acabas de cancelar NO es flaquear: es rehacer
-- la misma reserva (típico al cambiar de lugar en el mapa, o un toque en falso). No
-- debe contar contra el tope ni cobrar multa. Cancelar tarde y reservar una clase
-- DISTINTA sí sigue penalizando (eso sí es flaquear y tomar otro lugar).
--
-- FIX (único cambio vs 20260815200000): en el conteo v_total del tope diario, una
-- cancelación TARDE del mismo slot_inicio que se está re-reservando NO cuenta. Todo lo
-- demás es idéntico. Se reproduce verificar_limite_diario_reserva VERBATIM con ese
-- único cambio (la condición `AND slot_inicio <> NEW.slot_inicio`).
-- ============================================================================

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
  v_ventana int;    -- horas de anticipación para que una cancelación sea "a tiempo"
  v_total int;      -- reservas que USARON el cupo del día (vivas + no_show + canceladas TARDE)
  v_vivas int;      -- confirmadas/completadas → cupo realmente usado
  v_activa boolean;
  v_centavos int;
  v_acepta boolean;
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

  SELECT COALESCE(config->>'timezone', 'America/Mexico_City'),
         COALESCE((config->'reserva'->>'cancelacion_min_horas')::int, 4)
  INTO v_tz, v_ventana
  FROM tenants WHERE id = NEW.tenant_id;
  v_dia := (NEW.slot_inicio AT TIME ZONE v_tz)::date;

  -- v_total EXCLUYE las canceladas A TIEMPO (esas liberan el día) y TAMBIÉN la
  -- cancelación TARDE del MISMO horario que se está re-reservando (rehacer la misma
  -- clase no penaliza — caso Nayaysin). Las demás canceladas TARDE (cancelada_at
  -- dentro de la ventana previa a la clase) SÍ cuentan, igual que un no_show.
  -- v_vivas excluye toda cancelación y el no_show.
  SELECT
    count(*) FILTER (
      WHERE status NOT LIKE 'cancelada%'
         OR (cancelada_at IS NOT NULL
             AND cancelada_at >= slot_inicio - (v_ventana || ' hours')::interval
             AND slot_inicio <> NEW.slot_inicio)
    ),
    count(*) FILTER (WHERE status NOT LIKE 'cancelada%' AND status <> 'no_show')
  INTO v_total, v_vivas
  FROM reservas
  WHERE usuario_id = NEW.usuario_id
    AND (slot_inicio AT TIME ZONE v_tz)::date = v_dia;

  IF v_total < v_max THEN
    RETURN NEW;
  END IF;

  IF v_vivas >= v_max THEN
    RAISE EXCEPTION 'LIMITE_DIARIO: Tu plan permite % reserva(s) por día', v_max;
  END IF;

  -- Al tope por no_show(s) o cancelación(es) TARDE → entra el Modelo A.
  SELECT
    COALESCE((config->'penalizaciones'->>'multa_rereserva_activa')::boolean, false),
    COALESCE((config->'penalizaciones'->>'multa_rereserva_centavos')::int, 7500)
  INTO v_activa, v_centavos
  FROM tenants WHERE id = NEW.tenant_id;

  IF NOT v_activa THEN
    RAISE EXCEPTION 'LIMITE_DIARIO: Tu plan permite % reserva(s) por día', v_max;
  END IF;

  v_acepta := COALESCE(current_setting('sala.acepta_multa', true), '') = 'on';
  IF NOT v_acepta THEN
    RAISE EXCEPTION 'MULTA_REQUERIDA: %', v_centavos;
  END IF;

  NEW.multa_centavos := v_centavos;
  NEW.multa_pagada := false;
  RETURN NEW;
END; $$;

-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA. Con tope 1/día + Modelo A on:
--   1) cancela A TIEMPO → 2da (otro horario) PERMITIDA gratis.
--   2) cancela TARDE + re-reserva OTRO horario → pide MULTA (sigue penalizando).
--   3) cancela TARDE + re-reserva el MISMO horario → PERMITIDA gratis (el fix).
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_rereserva_mismo_slot()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_socio uuid; v_tier uuid; v_recurso uuid; v_tz text;
  v_dia date; v_s1 timestamptz; v_s2 timestamptz; v_r1 uuid;
  v_atiempo text := '(no corrió)';
  v_otro    text := '(no corrió)';
  v_mismo   text := '(no corrió)';
BEGIN
  BEGIN
    SELECT id INTO v_tenant FROM tenants WHERE status='activo' ORDER BY created_at LIMIT 1;
    SELECT id INTO v_recurso FROM recursos WHERE tenant_id=v_tenant LIMIT 1;
    v_tz := COALESCE((SELECT config->>'timezone' FROM tenants WHERE id=v_tenant),'America/Mexico_City');

    INSERT INTO usuarios (tenant_id,email,nombre,rol,status)
    VALUES (v_tenant,'rereserva-slot-test@example.com','Rereserva Slot Test','miembro','activo')
    RETURNING id INTO v_socio;
    INSERT INTO tiers (tenant_id,slug,nombre,tipo,precio_centavos,moneda,duracion_dias,max_reservas_dia,activo,orden)
    VALUES (v_tenant,'rereserva-slot-test','Rereserva Slot Test','tiempo',100000,'MXN',30,1,true,998)
    RETURNING id INTO v_tier;
    INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin)
    VALUES (v_tenant,v_socio,v_tier,'activa',now(),now()+interval '30 days');

    -- Modelo A on + ventana conocida (4h). Se revierte con el sub-bloque.
    UPDATE tenants SET config = COALESCE(config,'{}'::jsonb)
      || jsonb_build_object('reserva',
           COALESCE(config->'reserva','{}'::jsonb) || jsonb_build_object('cancelacion_min_horas', 4))
      || jsonb_build_object('penalizaciones',
           COALESCE(config->'penalizaciones','{}'::jsonb)
           || jsonb_build_object('multa_rereserva_activa', true, 'multa_rereserva_centavos', 7500))
      WHERE id = v_tenant;

    v_dia := (now() AT TIME ZONE v_tz)::date + 3;
    v_s1 := (v_dia + time '10:00') AT TIME ZONE v_tz;
    v_s2 := (v_dia + time '11:00') AT TIME ZONE v_tz;

    INSERT INTO reservas (tenant_id,recurso_id,usuario_id,slot_inicio,slot_fin,duracion_min,folio,status)
    VALUES (v_tenant,v_recurso,v_socio,v_s1,v_s1+interval '1 hour',60,'TEST-RS-1','confirmada')
    RETURNING id INTO v_r1;

    PERFORM set_config('sala.acepta_multa','off',true);

    -- 1) Cancelada A TIEMPO (slot − 6h) → 2da (otro horario) gratis.
    UPDATE reservas SET status='cancelada', cancelada_at = v_s1 - interval '6 hours' WHERE id=v_r1;
    BEGIN
      INSERT INTO reservas (tenant_id,recurso_id,usuario_id,slot_inicio,slot_fin,duracion_min,folio,status)
      VALUES (v_tenant,v_recurso,v_socio,v_s2,v_s2+interval '1 hour',60,'TEST-RS-2','confirmada');
      v_atiempo := '✅ 2da permitida (canceló a tiempo, gratis)';
      DELETE FROM reservas WHERE folio='TEST-RS-2' AND tenant_id=v_tenant;
    EXCEPTION WHEN OTHERS THEN
      v_atiempo := '❌ pidió multa/bloqueó cancelando a tiempo: '||SQLERRM;
    END;

    -- 2) Cancelada TARDE (slot − 30min) + re-reserva OTRO horario → pide MULTA.
    UPDATE reservas SET cancelada_at = v_s1 - interval '30 minutes' WHERE id=v_r1;
    BEGIN
      INSERT INTO reservas (tenant_id,recurso_id,usuario_id,slot_inicio,slot_fin,duracion_min,folio,status)
      VALUES (v_tenant,v_recurso,v_socio,v_s2,v_s2+interval '1 hour',60,'TEST-RS-3','confirmada');
      v_otro := '❌ dejó reservar OTRO horario gratis cancelando tarde';
      DELETE FROM reservas WHERE folio='TEST-RS-3' AND tenant_id=v_tenant;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'MULTA_REQUERIDA%' THEN v_otro := '✅ pide multa por OTRO horario (sigue penalizando)';
      ELSE v_otro := '⚠ otro: '||SQLERRM; END IF;
    END;

    -- 3) Cancelada TARDE (slot − 30min) + re-reserva el MISMO horario → gratis (fix).
    BEGIN
      INSERT INTO reservas (tenant_id,recurso_id,usuario_id,slot_inicio,slot_fin,duracion_min,folio,status)
      VALUES (v_tenant,v_recurso,v_socio,v_s1,v_s1+interval '1 hour',60,'TEST-RS-4','confirmada');
      v_mismo := '✅ re-reservar el MISMO horario NO cobra multa';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'MULTA_REQUERIDA%' THEN v_mismo := '❌ todavía cobra multa por el MISMO horario';
      ELSE v_mismo := '⚠ otro: '||SQLERRM; END IF;
    END;

    RAISE EXCEPTION 'ROLLBACK_RS';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_RS' THEN v_mismo := '❌ montaje falló: '||SQLERRM; END IF;
  END;

  prueba:='1. cancela A TIEMPO → 2da (otro horario) gratis'; resultado:=v_atiempo; RETURN NEXT;
  prueba:='2. cancela TARDE + OTRO horario → multa';          resultado:=v_otro;    RETURN NEXT;
  prueba:='3. cancela TARDE + MISMO horario → gratis (fix)';  resultado:=v_mismo;   RETURN NEXT;
  RETURN;
END $$;

SELECT * FROM _diag_rereserva_mismo_slot();
DROP FUNCTION _diag_rereserva_mismo_slot();
