-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- Cancelar TARDE cuenta como no_show para el tope diario (cierra el hueco).
-- ────────────────────────────────────────────────────────────────────────────
-- Antes: con el tope de 1 reserva/día, una reserva CANCELADA no contaba → el
-- socio podía cancelar (aunque fuera tardísimo) y re-reservar GRATIS. Pero FALTAR
-- (no_show) sí pedía multa. Asimetría: convenía cancelar tarde en vez de faltar,
-- vaciando la ventana de cancelación en planes por tiempo.
--
-- Ahora: cancelar A TIEMPO (dentro de la ventana cancelacion_min_horas) libera el
-- día → re-reservar gratis. Cancelar TARDE cuenta como no_show → re-reservar paga
-- la multa (Modelo A), igual que faltar. La "tardanza" se computa por reserva con
-- cancelada_at vs slot_inicio − ventana; no requiere columna nueva.
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

  -- v_total EXCLUYE solo las canceladas A TIEMPO (esas liberan el día). Las
  -- canceladas TARDE (cancelada_at dentro de la ventana previa a la clase) SÍ
  -- cuentan, igual que un no_show. v_vivas excluye toda cancelación y el no_show.
  SELECT
    count(*) FILTER (
      WHERE status NOT LIKE 'cancelada%'
         OR (cancelada_at IS NOT NULL
             AND cancelada_at >= slot_inicio - (v_ventana || ' hours')::interval)
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

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA. Con tope 1/día + Modelo A on:
--   1) 1ra cancelada A TIEMPO   → 2da reserva PERMITIDA (gratis).
--   2) 1ra cancelada TARDE       → 2da reserva pide MULTA_REQUERIDA.
-- Todo en un sub-bloque que se revierte.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _diag_cancel_tarde()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_socio uuid; v_tier uuid; v_recurso uuid; v_tz text;
  v_dia date; v_s1 timestamptz; v_s2 timestamptz; v_r1 uuid;
  v_atiempo text := '(no corrió)';
  v_tarde text := '(no corrió)';
BEGIN
  BEGIN
    SELECT id INTO v_tenant FROM tenants WHERE status='activo' ORDER BY created_at LIMIT 1;
    SELECT id INTO v_recurso FROM recursos WHERE tenant_id=v_tenant LIMIT 1;
    v_tz := COALESCE((SELECT config->>'timezone' FROM tenants WHERE id=v_tenant),'America/Mexico_City');

    INSERT INTO usuarios (tenant_id,email,nombre,rol,status)
    VALUES (v_tenant,'cancel-tarde-test@example.com','Cancel Tarde Test','miembro','activo')
    RETURNING id INTO v_socio;
    INSERT INTO tiers (tenant_id,slug,nombre,tipo,precio_centavos,moneda,duracion_dias,max_reservas_dia,activo,orden)
    VALUES (v_tenant,'cancel-tarde-test','Cancel Tarde Test','tiempo',100000,'MXN',30,1,true,999)
    RETURNING id INTO v_tier;
    INSERT INTO membresias (tenant_id,usuario_id,tier_id,status,periodo_actual_inicio,periodo_actual_fin)
    VALUES (v_tenant,v_socio,v_tier,'activa',now(),now()+interval '30 days');

    -- Modelo A on (se revierte con el sub-bloque).
    UPDATE tenants SET config = COALESCE(config,'{}'::jsonb)
      || jsonb_build_object('penalizaciones',
           COALESCE(config->'penalizaciones','{}'::jsonb)
           || jsonb_build_object('multa_rereserva_activa', true, 'multa_rereserva_centavos', 7500))
      WHERE id = v_tenant;

    v_dia := (now() AT TIME ZONE v_tz)::date + 3;
    v_s1 := (v_dia + time '10:00') AT TIME ZONE v_tz;
    v_s2 := (v_dia + time '11:00') AT TIME ZONE v_tz;

    INSERT INTO reservas (tenant_id,recurso_id,usuario_id,slot_inicio,slot_fin,duracion_min,folio,status)
    VALUES (v_tenant,v_recurso,v_socio,v_s1,v_s1+interval '1 hour',60,'TEST-CT-1','confirmada')
    RETURNING id INTO v_r1;

    -- 1) Cancelada A TIEMPO (cancelada_at = slot − 6h; ventana 4h) → NO cuenta.
    UPDATE reservas SET status='cancelada', cancelada_at = v_s1 - interval '6 hours' WHERE id=v_r1;
    PERFORM set_config('sala.acepta_multa','off',true);
    BEGIN
      INSERT INTO reservas (tenant_id,recurso_id,usuario_id,slot_inicio,slot_fin,duracion_min,folio,status)
      VALUES (v_tenant,v_recurso,v_socio,v_s2,v_s2+interval '1 hour',60,'TEST-CT-2','confirmada');
      v_atiempo := '✅ 2da reserva permitida (canceló a tiempo, gratis)';
      DELETE FROM reservas WHERE folio='TEST-CT-2' AND tenant_id=v_tenant;  -- limpiar para el 2do caso
    EXCEPTION WHEN OTHERS THEN
      v_atiempo := '❌ bloqueó/pidió multa cancelando a tiempo: '||SQLERRM;
    END;

    -- 2) Cancelada TARDE (cancelada_at = slot − 1h) → cuenta como no_show → multa.
    UPDATE reservas SET cancelada_at = v_s1 - interval '1 hour' WHERE id=v_r1;
    BEGIN
      INSERT INTO reservas (tenant_id,recurso_id,usuario_id,slot_inicio,slot_fin,duracion_min,folio,status)
      VALUES (v_tenant,v_recurso,v_socio,v_s2,v_s2+interval '1 hour',60,'TEST-CT-3','confirmada');
      v_tarde := '❌ dejó reservar gratis cancelando tarde (hueco sigue abierto)';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'MULTA_REQUERIDA%' THEN v_tarde := '✅ pide MULTA cancelando tarde (igual que no_show)';
      ELSE v_tarde := '⚠ otro: '||SQLERRM; END IF;
    END;

    RAISE EXCEPTION 'ROLLBACK_CT';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_CT' THEN v_tarde := '❌ montaje falló: '||SQLERRM; END IF;
  END;

  prueba:='1. cancela A TIEMPO → 2da gratis'; resultado:=v_atiempo; RETURN NEXT;
  prueba:='2. cancela TARDE → 2da con multa';  resultado:=v_tarde;   RETURN NEXT;
  RETURN;
END $$;

SELECT * FROM _diag_cancel_tarde();
DROP FUNCTION _diag_cancel_tarde();
