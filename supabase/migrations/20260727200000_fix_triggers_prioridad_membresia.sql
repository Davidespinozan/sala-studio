-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- FIX — los triggers de reservas (días de acceso / máx por día) elegían la
-- membresía distinto al gate de reservar → podían bloquear una reserva legítima.
-- ────────────────────────────────────────────────────────────────────────────
-- Los triggers verificar_dia_acceso_reserva y verificar_limite_diario_reserva
-- tomaban la membresía con `ORDER BY created_at DESC` (la más nueva). El gate
-- canónico (reservar_clase) usa PRIORIDAD POR STATUS: activa > trialing >
-- past_due > congelada, y recién ahí created_at DESC.
--
-- Bug: un socio con dos membresías vigentes (p. ej. tras un cambio de plan: una
-- 'activa' sin restricción + una más nueva 'past_due'/'congelada' con dias_acceso
-- lun-vie) → el gate reserva con la 'activa' (permite sábado), pero el trigger
-- leía la más nueva y lanzaba DIA_NO_PERMITIDO/LIMITE_DIARIO sobre un plan que el
-- gate no considera el vigente. Reserva legítima bloqueada.
--
-- Fix: ambos triggers usan el MISMO orden por prioridad de status que el gate.
-- ════════════════════════════════════════════════════════════════════════════

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
  SELECT t.dias_acceso INTO v_dias
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = NEW.usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
  ORDER BY
    CASE m.status WHEN 'activa' THEN 0 WHEN 'trialing' THEN 1 WHEN 'past_due' THEN 2 WHEN 'congelada' THEN 3 ELSE 4 END,
    m.created_at DESC
  LIMIT 1;

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
  ORDER BY
    CASE m.status WHEN 'activa' THEN 0 WHEN 'trialing' THEN 1 WHEN 'past_due' THEN 2 WHEN 'congelada' THEN 3 ELSE 4 END,
    m.created_at DESC
  LIMIT 1;

  IF v_max IS NULL OR v_max < 1 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(config->>'timezone', 'America/Mexico_City') INTO v_tz
  FROM tenants WHERE id = NEW.tenant_id;
  v_dia := (NEW.slot_inicio AT TIME ZONE v_tz)::date;

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

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — un socio con 'activa' sin restricción + una 'past_due' MÁS NUEVA que
-- restringe a lun-vie: reservar un SÁBADO debe PASAR (el trigger elige la activa,
-- como el gate). Con el bug (created_at DESC) se bloqueaba. Se auto-verifica y
-- revierte.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tenant uuid; v_socio uuid; v_t_libre uuid; v_t_restr uuid; v_recurso uuid; v_tz text;
  v_sabado timestamptz; v_dia date;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE status='activo' ORDER BY created_at LIMIT 1;
  IF v_tenant IS NULL THEN RAISE NOTICE 'TEST SKIP: sin tenant.'; RETURN; END IF;
  SELECT id INTO v_recurso FROM recursos WHERE tenant_id=v_tenant LIMIT 1;
  IF v_recurso IS NULL THEN RAISE NOTICE 'TEST SKIP: sin recurso.'; RETURN; END IF;
  v_tz := COALESCE((SELECT config->>'timezone' FROM tenants WHERE id=v_tenant), 'America/Mexico_City');

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, 'prioridad-test@example.com', 'Prioridad Test', 'miembro', 'activo')
  RETURNING id INTO v_socio;

  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, activo, orden)
  VALUES (v_tenant, 'prio-libre', 'Libre', 'tiempo', 100000, 'MXN', 30, true, 998)
  RETURNING id INTO v_t_libre;
  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, dias_acceso, activo, orden)
  VALUES (v_tenant, 'prio-restr', 'Restr', 'tiempo', 100000, 'MXN', 30, ARRAY[1,2,3,4,5], true, 999)
  RETURNING id INTO v_t_restr;

  -- 'activa' (más vieja, sin restricción) + 'congelada' (más NUEVA, lun-vie).
  -- Se usa 'congelada' porque el índice membresias_one_active_per_user solo cubre
  -- (trialing/activa/past_due): un socio puede tener activa + congelada a la vez,
  -- y el trigger mira las 4, así que la prioridad por status importa.
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, created_at)
  VALUES (v_tenant, v_socio, v_t_libre, 'activa', now(), now() + interval '30 days', now() - interval '10 days');
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, created_at)
  VALUES (v_tenant, v_socio, v_t_restr, 'congelada', now(), now() + interval '30 days', now());

  v_dia := (now() AT TIME ZONE v_tz)::date;
  v_sabado := ((date_trunc('week', v_dia)::date + 5) + time '12:00') AT TIME ZONE v_tz;
  IF v_sabado <= now() THEN v_sabado := v_sabado + interval '7 days'; END IF;

  -- Debe PASAR (elige la 'activa' sin restricción). Con el bug lanzaría DIA_NO_PERMITIDO.
  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status)
  VALUES (v_tenant, v_recurso, v_socio, v_sabado, v_sabado + interval '1 hour', 60, 'TEST-PRIO', 'confirmada');

  RAISE EXCEPTION 'ROLLBACK_OK_PRIO';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM = 'ROLLBACK_OK_PRIO' THEN NULL;
  ELSIF SQLERRM LIKE 'DIA_NO_PERMITIDO%' THEN
    RAISE EXCEPTION 'TEST FALLO: el trigger bloqueó el sábado usando la membresía past_due en vez de la activa.';
  ELSE RAISE;
  END IF;
END $$;

SELECT 'triggers de reserva alineados con la prioridad de status del gate' AS prueba, true AS ok;
