-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- FIX — al cancelar una reserva DESDE ADMIN, el socio no podía volver a reservar.
-- ────────────────────────────────────────────────────────────────────────────
-- El trigger del tope diario (verificar_limite_diario_reserva) contaba las
-- reservas del día excluyendo SOLO `status = 'cancelada'` (la cancelación del
-- socio). Pero cuando cancela el ADMIN el status es `'cancelada_admin'` (y
-- cancelar_clase también). Ese status NO se excluía → la reserva cancelada
-- seguía contando como "viva" → el socio quedaba topado y no podía volver a
-- reservar (LIMITE_DIARIO), como si ya hubiera asistido.
--
-- Fix: excluir CUALQUIER cancelación (`status LIKE 'cancelada%'` cubre
-- 'cancelada' y 'cancelada_admin', y cualquier futura variante). Nada más cambia:
-- las reservas vivas (confirmada/completada) y los no_show cuentan igual, y el
-- Modelo A de multa por re-reservar tras no_show sigue idéntico.
-- ════════════════════════════════════════════════════════════════════════════

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
  v_total int;   -- reservas NO canceladas del día (no_show incluidos)
  v_vivas int;   -- NO canceladas y NO no_show → cupo realmente usado
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

  SELECT COALESCE(config->>'timezone', 'America/Mexico_City') INTO v_tz
  FROM tenants WHERE id = NEW.tenant_id;
  v_dia := (NEW.slot_inicio AT TIME ZONE v_tz)::date;

  -- 'cancelada%' cubre 'cancelada' (socio) Y 'cancelada_admin' (admin/cancelar_clase):
  -- una reserva cancelada, la haya cancelado quien la haya cancelado, NO cuenta.
  SELECT
    count(*) FILTER (WHERE status NOT LIKE 'cancelada%'),
    count(*) FILTER (WHERE status NOT LIKE 'cancelada%' AND status <> 'no_show')
  INTO v_total, v_vivas
  FROM reservas
  WHERE usuario_id = NEW.usuario_id
    AND (slot_inicio AT TIME ZONE v_tz)::date = v_dia;

  -- Debajo del tope contando TODO → permite normal.
  IF v_total < v_max THEN
    RETURN NEW;
  END IF;

  -- Al tope por reservas VIVAS → bloquea: ya usó su cupo de verdad, la multa no aplica.
  IF v_vivas >= v_max THEN
    RAISE EXCEPTION 'LIMITE_DIARIO: Tu plan permite % reserva(s) por día', v_max;
  END IF;

  -- Al tope SOLO por no_show(s) → entra el Modelo A.
  SELECT
    COALESCE((config->'penalizaciones'->>'multa_rereserva_activa')::boolean, false),
    COALESCE((config->'penalizaciones'->>'multa_rereserva_centavos')::int, 7500)
  INTO v_activa, v_centavos
  FROM tenants WHERE id = NEW.tenant_id;

  -- Modelo A apagado → comportamiento de siempre.
  IF NOT v_activa THEN
    RAISE EXCEPTION 'LIMITE_DIARIO: Tu plan permite % reserva(s) por día', v_max;
  END IF;

  -- ¿El socio ya aceptó la multa? (flag por transacción que pone el RPC de reservar)
  v_acepta := COALESCE(current_setting('sala.acepta_multa', true), '') = 'on';
  IF NOT v_acepta THEN
    RAISE EXCEPTION 'MULTA_REQUERIDA: %', v_centavos;
  END IF;

  -- Aceptó → estampar la multa en la reserva y permitir.
  NEW.multa_centavos := v_centavos;
  NEW.multa_pagada := false;
  RETURN NEW;
END; $$;

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA. Monta un socio con tope 1/día y prueba:
--   1) con la 1ra reserva VIVA, la 2da se bloquea (regresión intacta).
--   2) si ADMIN cancela la 1ra (cancelada_admin), SÍ deja volver a reservar (el fix).
-- Todo dentro de un sub-bloque que se revierte; no deja datos.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _diag_limite_cancel()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_socio uuid; v_tier uuid; v_recurso uuid; v_tz text;
  v_dia date; v_s1 timestamptz; v_s2 timestamptz; v_r1 uuid;
  v_viva text := '(no corrió)';
  v_cancel text := '(no corrió)';
BEGIN
  BEGIN
    SELECT id INTO v_tenant FROM tenants WHERE status='activo' ORDER BY created_at LIMIT 1;
    SELECT id INTO v_recurso FROM recursos WHERE tenant_id=v_tenant LIMIT 1;
    v_tz := COALESCE((SELECT config->>'timezone' FROM tenants WHERE id=v_tenant),'America/Mexico_City');

    INSERT INTO usuarios (tenant_id,email,nombre,rol,status)
    VALUES (v_tenant,'limite-cancel-test@example.com','Límite Cancel Test','miembro','activo')
    RETURNING id INTO v_socio;
    INSERT INTO tiers (tenant_id,slug,nombre,tipo,precio_centavos,moneda,duracion_dias,max_reservas_dia,activo,orden)
    VALUES (v_tenant,'limite-cancel-test','Límite Cancel Test','tiempo',100000,'MXN',30,1,true,999)
    RETURNING id INTO v_tier;
    INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin)
    VALUES (v_tenant,v_socio,v_tier,'activa',now(),now()+interval '30 days');

    v_dia := (now() AT TIME ZONE v_tz)::date + 3;
    v_s1 := (v_dia + time '10:00') AT TIME ZONE v_tz;
    v_s2 := (v_dia + time '11:00') AT TIME ZONE v_tz;

    INSERT INTO reservas (tenant_id,recurso_id,usuario_id,slot_inicio,slot_fin,duracion_min,folio,status)
    VALUES (v_tenant,v_recurso,v_socio,v_s1,v_s1+interval '1 hour',60,'TEST-LC-1','confirmada')
    RETURNING id INTO v_r1;

    -- 1) con la 1ra VIVA → bloquea
    BEGIN
      INSERT INTO reservas (tenant_id,recurso_id,usuario_id,slot_inicio,slot_fin,duracion_min,folio,status)
      VALUES (v_tenant,v_recurso,v_socio,v_s2,v_s2+interval '1 hour',60,'TEST-LC-2','confirmada');
      v_viva := '❌ dejó reservar con la 1ra viva (regresión rota)';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'LIMITE_DIARIO%' THEN v_viva := '✅ bloquea con la 1ra viva';
      ELSE v_viva := '⚠ otro: '||SQLERRM; END IF;
    END;

    -- 2) admin cancela la 1ra → nueva reserva DEBE pasar
    UPDATE reservas SET status='cancelada_admin' WHERE id=v_r1;
    BEGIN
      INSERT INTO reservas (tenant_id,recurso_id,usuario_id,slot_inicio,slot_fin,duracion_min,folio,status)
      VALUES (v_tenant,v_recurso,v_socio,v_s2,v_s2+interval '1 hour',60,'TEST-LC-3','confirmada');
      v_cancel := '✅ tras cancelar (admin), SÍ deja volver a reservar';
    EXCEPTION WHEN OTHERS THEN
      v_cancel := '❌ sigue bloqueado tras cancelar: '||SQLERRM;
    END;

    RAISE EXCEPTION 'ROLLBACK_LC';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_LC' THEN v_cancel := '❌ montaje falló: '||SQLERRM; END IF;
  END;

  prueba:='1. 1ra reserva viva → bloquea';              resultado:=v_viva;   RETURN NEXT;
  prueba:='2. admin cancela → deja re-reservar (fix)';  resultado:=v_cancel; RETURN NEXT;
  RETURN;
END $$;

SELECT * FROM _diag_limite_cancel();
DROP FUNCTION _diag_limite_cancel();
