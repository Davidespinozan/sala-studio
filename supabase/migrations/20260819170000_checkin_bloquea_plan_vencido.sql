-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- CHECK-IN: plan vencido NO entra (regla del dueño). Day pass sigue siendo la excepción.
-- ----------------------------------------------------------------------------
-- Regla (numa): "en cuanto se acaba el vencimiento del plan —por clases o por
-- mensualidad— el socio ya no debe poder entrar." El gate de RESERVAR ya lo topa
-- (MEMBRESIA_VENCIDA por periodo_actual_fin), y los créditos ya caducan con el plan
-- (cron, 20260819140000). Faltaba el CHECK-IN.
--
-- Antecedente: 20260819130000 dejó el guard de check-in como NO-OP para que un day
-- pass que reservaba fuera de su semana igual pudiera entrar. Pero eso fue DEMASIADO
-- amplio: dejaba entrar a CUALQUIER plan vencido. El day pass NO necesitaba ese no-op
-- —el trigger pase_sigue_a_reserva (es_pase=true) EXTIENDE periodo_actual_fin hasta el
-- fin del día de la clase, así que al entrar NO está vencido y _estado da 'ok'.
--
-- FIX: el guard vuelve a bloquear plan vencido/congelado/sin membresía en las vías
-- AUTOMÁTICAS (QR y huella). El check-in MANUAL sigue SIN bloquear (recepción decide
-- con criterio y ve el estado). El day pass sigue entrando porque su vigencia se
-- extendió (no está 'vencida'). _estado_membresia_checkin no se toca (ya reconoce
-- 'expirada'→'vencida' desde 20260819130000).
-- ============================================================================

CREATE OR REPLACE FUNCTION _guard_membresia_checkin(p_usuario_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_estado text := _estado_membresia_checkin(p_usuario_id);
BEGIN
  -- Plan vencido / pausado / sin membresía → no entra por QR ni huella (automáticas).
  -- El day pass no cae aquí: su vigencia se extendió a la clase, así que da 'ok'.
  -- (La vía MANUAL no llama este guard: recepción puede dejar entrar con criterio.)
  IF v_estado = 'sin_membresia' THEN
    RAISE EXCEPTION 'SIN_MEMBRESIA: El socio no tiene una membresía activa';
  ELSIF v_estado = 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_CONGELADA: La membresía del socio está pausada';
  ELSIF v_estado = 'vencida' THEN
    RAISE EXCEPTION 'MEMBRESIA_VENCIDA: La membresía del socio venció; ya no puede entrar';
  END IF;
END;
$$;


-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA.
--   1) Plan VENCIDO (fin en el pasado) → el guard BLOQUEA (no entra).
--   2) Plan VIGENTE (fin futuro) → el guard PASA (entra).
--   3) Membresía tipo day pass con vigencia EXTENDIDA a futuro → PASA (entra),
--      demostrando que el day pass no se rompe.
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_checkin_vencido()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_tier uuid; v_pase uuid;
  v_venc uuid; v_vig uuid; v_dp uuid;
  v_r text;
BEGIN
  BEGIN
    SELECT id INTO v_tenant FROM tenants WHERE status = 'activo' ORDER BY created_at LIMIT 1;

    INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, clases_incluidas, es_pase, activo, orden)
    VALUES (v_tenant, 'chk-venc-normal', 'Chk Venc', 'hibrido', 10000, 'MXN', 7, 7, false, true, 990)
    RETURNING id INTO v_tier;
    INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, clases_incluidas, es_pase, activo, orden)
    VALUES (v_tenant, 'chk-venc-pase', 'Chk Pase', 'hibrido', 10000, 'MXN', 7, 1, true, true, 991)
    RETURNING id INTO v_pase;

    -- 1) Socio con plan normal VENCIDO (fin ayer) + crédito → debe bloquear.
    INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
    VALUES (v_tenant, 'chk-venc@x.dev', 'Vencido', 'miembro', 'activo') RETURNING id INTO v_venc;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
    VALUES (v_tenant, v_venc, v_tier, 'activa', now() - interval '8 days', now() - interval '1 day', 3);

    -- 2) Socio con plan VIGENTE (fin en 3 días) → debe pasar.
    INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
    VALUES (v_tenant, 'chk-vig@x.dev', 'Vigente', 'miembro', 'activo') RETURNING id INTO v_vig;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
    VALUES (v_tenant, v_vig, v_tier, 'activa', now() - interval '4 days', now() + interval '3 days', 3);

    -- 3) Day pass con vigencia EXTENDIDA a futuro (como deja el trigger) → debe pasar.
    INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
    VALUES (v_tenant, 'chk-dp@x.dev', 'DayPass', 'miembro', 'activo') RETURNING id INTO v_dp;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
    VALUES (v_tenant, v_dp, v_pase, 'activa', now() - interval '9 days', now() + interval '1 day', 1);

    prueba := '1. plan VENCIDO → no entra';
    BEGIN PERFORM _guard_membresia_checkin(v_venc);
      resultado := '❌ dejó entrar a un vencido';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_r = MESSAGE_TEXT;
      resultado := CASE WHEN v_r LIKE 'MEMBRESIA_VENCIDA%' THEN '✅ bloqueó (vencido)' ELSE '⚠ otro: ' || v_r END;
    END; RETURN NEXT;

    prueba := '2. plan VIGENTE → entra';
    BEGIN PERFORM _guard_membresia_checkin(v_vig); resultado := '✅ deja entrar';
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_r = MESSAGE_TEXT; resultado := '❌ bloqueó a un vigente: ' || v_r; END;
    RETURN NEXT;

    prueba := '3. day pass con vigencia extendida → entra';
    BEGIN PERFORM _guard_membresia_checkin(v_dp); resultado := '✅ deja entrar (no se rompe el day pass)';
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_r = MESSAGE_TEXT; resultado := '❌ bloqueó al day pass: ' || v_r; END;
    RETURN NEXT;

    RAISE EXCEPTION 'ROLLBACK_CHKV';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_CHKV' THEN
      prueba := 'montaje'; resultado := '❌ falló: ' || SQLERRM; RETURN NEXT;
    END IF;
  END;
  RETURN;
END $$;

SELECT * FROM _diag_checkin_vencido();
DROP FUNCTION _diag_checkin_vencido();
