-- ============================================================================
-- Plan "por cobrar": cancelarlo (staff y socio) y pagarlo con tarjeta
-- ============================================================================
-- Caso The Core (22-oct-2026): una socia eligió "Pagar en recepción" para la
-- clase de prueba. Tres huecos:
--
--   1) Admin/recepción "Cancelar" el cargo en Por cobrar solo marcaba el cargo
--      como cancelado: la membresía seguía activa (clases, reservas, acceso al
--      pagar… nunca) y desaparecía de la lista. Plan gratis por accidente.
--   2) La socia no tenía forma de cancelar su plan por cobrar desde la app
--      ("Cancelar suscripción" solo cancela suscripciones de Stripe).
--   3) La socia quería pagar los $99 con tarjeta y no había cómo: el cobro de
--      un pendiente era exclusivo de recepción (cobrar_cargo_pendiente).
--
-- Qué hace esta migración:
--   A) _cancelar_plan_por_cobrar(usuario, motivo): helper interno. Si la
--      membresía actual del socio NO tiene ningún pago registrado y existe un
--      cargo de plan pendiente, cancela la membresía (status cancelada), libera
--      sus reservas futuras (_liberar_reservas_membresia), cancela TODOS sus
--      cargos pendientes de plan/inscripción y, si era la clase de prueba y no
--      la tomó, libera la marca de pruebas_usadas para que pueda elegirla otra
--      vez. Si la membresía ya tiene pagos (p. ej. renovación "dejar pendiente"
--      sobre un plan pagado) NO la toca: solo el cargo se cancela, y lo dice.
--   B) cancelar_cargo_pendiente: al cancelar un cargo de concepto 'plan' llama
--      al helper. Recepción ya podía cancelar a nivel RPC (is_recepcionista);
--      la UI le abre el botón solo para cargos de plan.
--   C) socio_cancelar_plan_por_cobrar(): el socio cancela su plan nunca pagado.
--   D) stripe_cobrar_cargos_pendientes(event, cargos[], referencia, cuenta):
--      service_role (webhook). Marca cobrados los cargos que sigan pendientes
--      (pago metodo 'stripe', misma forma que cobrar_cargo_pendiente) y devuelve
--      cuánto NO pudo aplicar (cargo ya cobrado en mostrador o cancelado) para
--      que el webhook lo reembolse. Marca el evento processed en la misma tx.
--
-- Bitácora: _audrec_log exige rol staff; desde el socio se intenta best-effort
-- (subtransacción) para no revertir la cancelación por un log.
-- ============================================================================

-- ── A) helper interno ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _cancelar_plan_por_cobrar(p_usuario_id uuid, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target uuid;
  v_mem RECORD;
  v_tier RECORD;
  v_pagos integer;
  v_cargos integer;
  v_cargo_plan integer;
  v_tomo_clase boolean := false;
  v_prueba_liberada boolean := false;
  v_motivo text := COALESCE(NULLIF(trim(p_motivo), ''), 'Plan por cobrar cancelado sin pagar');
BEGIN
  -- Membresía actual (no terminal). Sin lock todavía: orden canónico R → X → M.
  SELECT m.id INTO v_target
  FROM membresias m
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('activa', 'trialing', 'past_due', 'congelada')
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_target IS NULL THEN
    RETURN jsonb_build_object('plan_cancelado', false, 'reason', 'sin_membresia');
  END IF;

  PERFORM _bloquear_fin_membresias(ARRAY[v_target]);

  SELECT m.id, m.status, m.tenant_id, m.tier_id, m.periodo_actual_inicio, m.created_at,
         m.stripe_subscription_id, u.nombre
  INTO v_mem
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.id = v_target
  FOR UPDATE OF m;

  IF v_mem.id IS NULL OR v_mem.status NOT IN ('activa', 'trialing', 'past_due', 'congelada') THEN
    RETURN jsonb_build_object('plan_cancelado', false, 'reason', 'membresia_cambio');
  END IF;
  -- Un plan por cobrar nunca tiene Stripe detrás; si lo tiene, no es este caso.
  IF v_mem.stripe_subscription_id IS NOT NULL THEN
    RETURN jsonb_build_object('plan_cancelado', false, 'reason', 'tiene_stripe');
  END IF;

  -- ¿Es realmente "por cobrar"? Debe existir un cargo de plan pendiente…
  SELECT count(*) INTO v_cargo_plan
  FROM cargos_pendientes
  WHERE usuario_id = p_usuario_id AND estado = 'pendiente' AND concepto = 'plan';
  IF v_cargo_plan = 0 THEN
    RETURN jsonb_build_object('plan_cancelado', false, 'reason', 'sin_cargo_plan');
  END IF;

  -- …y la membresía no debe tener NINGÚN pago de plan. Si lo tiene (renovación
  -- dejada pendiente sobre un plan ya pagado), cancelar el cargo no debe tumbar
  -- lo pagado. La inscripción pagada aparte no cuenta: queda pagada (usuarios.
  -- inscripcion_pagada_at) y le sirve para el plan que sí compre.
  SELECT count(*) INTO v_pagos
  FROM pagos p
  WHERE p.usuario_id = p_usuario_id
    AND p.concepto IN ('plan', 'paquete')
    AND (p.membresia_id = v_mem.id OR p.created_at >= v_mem.created_at);
  IF v_pagos > 0 THEN
    RETURN jsonb_build_object('plan_cancelado', false, 'reason', 'tiene_pagos');
  END IF;

  SELECT t.nombre, COALESCE(t.es_prueba, false) AS es_prueba INTO v_tier
  FROM tiers t WHERE t.id = v_mem.tier_id;

  -- ¿Alcanzó a tomar clase con este plan? (check-in bloqueado con deuda desde
  -- 20261022100000, pero planes "dejar pendiente" previos pudieron entrar).
  SELECT EXISTS (
    SELECT 1 FROM reservas r
    WHERE r.usuario_id = p_usuario_id
      AND r.status = 'completada'
      AND r.slot_inicio >= COALESCE(v_mem.periodo_actual_inicio, v_mem.created_at)
  ) INTO v_tomo_clase;

  UPDATE membresias
  SET status = 'cancelada', cancelada_at = now(), updated_at = now()
  WHERE id = v_mem.id;

  -- Cache: el trigger de W5-B también lo limpia; se mantiene por robustez.
  UPDATE usuarios
  SET membresia_tier = NULL, membresia_activa_id = NULL
  WHERE id = p_usuario_id;

  -- Perdió el entitlement: sus reservas futuras se liberan sin débito.
  PERFORM _liberar_reservas_membresia(v_mem.id);

  -- Todos los pendientes de ese plan (plan + inscripción) caen con él.
  UPDATE cargos_pendientes
  SET estado = 'cancelado',
      motivo_cancelacion = COALESCE(motivo_cancelacion, v_motivo)
  WHERE usuario_id = p_usuario_id
    AND estado = 'pendiente'
    AND concepto IN ('plan', 'inscripcion');
  GET DIAGNOSTICS v_cargos = ROW_COUNT;

  -- Clase de prueba que nunca pagó ni tomó: puede volver a elegirla.
  IF v_tier.es_prueba AND NOT v_tomo_clase THEN
    DELETE FROM pruebas_usadas WHERE usuario_id = p_usuario_id;
    v_prueba_liberada := FOUND;
  END IF;

  -- Bitácora best-effort: desde el socio _audrec_log rechaza el rol.
  BEGIN
    PERFORM _audrec_log(
      'membresia.cancelar', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
      format('Canceló el plan por cobrar (%s) sin pagar. Motivo: %s', v_tier.nombre, v_motivo),
      jsonb_build_object('motivo', v_motivo, 'por_cobrar', true, 'cargos_cancelados', v_cargos,
                         'prueba_liberada', v_prueba_liberada)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'plan_cancelado', true,
    'membresia_id', v_mem.id,
    'tier_nombre', v_tier.nombre,
    'cargos_cancelados', v_cargos,
    'prueba_liberada', v_prueba_liberada
  );
END;
$$;
REVOKE ALL ON FUNCTION _cancelar_plan_por_cobrar(uuid, text) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION _cancelar_plan_por_cobrar(uuid, text) IS
  'Interno. Cancela la membresía actual del socio si está "por cobrar" (cargo de plan pendiente y cero pagos): status cancelada, reservas futuras liberadas, cargos de plan/inscripción cancelados, prueba liberada si no la tomó. Devuelve plan_cancelado=false con reason si no aplica.';

-- ── B) cancelar_cargo_pendiente: un cargo de plan se lleva el plan ──────────
CREATE OR REPLACE FUNCTION public.cancelar_cargo_pendiente(p_cargo_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cargo cargos_pendientes;
  v_plan jsonb := NULL;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden cancelar';
  END IF;
  SELECT * INTO v_cargo FROM cargos_pendientes WHERE id = p_cargo_id FOR UPDATE;
  IF v_cargo.id IS NULL OR v_cargo.tenant_id <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'CARGO_NO_EXISTE: Ese cargo no es de este gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_cargo.sucursal_id);
  IF v_cargo.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'CARGO_NO_PENDIENTE: Ese cargo ya está %', v_cargo.estado;
  END IF;

  -- Cargo de plan por cobrar: el plan nunca se pagó → cae junto con el cargo.
  -- (Si la membresía ya tenía pagos, el helper no la toca y lo reporta.)
  IF v_cargo.concepto = 'plan' THEN
    v_plan := _cancelar_plan_por_cobrar(v_cargo.usuario_id, p_motivo);
  END IF;

  UPDATE cargos_pendientes
  SET estado = 'cancelado',
      motivo_cancelacion = COALESCE(NULLIF(trim(p_motivo), ''), motivo_cancelacion)
  WHERE id = p_cargo_id;

  RETURN jsonb_build_object('success', true)
      || COALESCE(jsonb_build_object('plan', v_plan), '{}'::jsonb);
END;
$function$;
REVOKE ALL ON FUNCTION cancelar_cargo_pendiente(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancelar_cargo_pendiente(uuid, text) TO authenticated;

-- ── C) el socio cancela su plan por cobrar ──────────────────────────────────
CREATE OR REPLACE FUNCTION socio_cancelar_plan_por_cobrar()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_tenant uuid;
  v_res jsonb;
BEGIN
  v_actor := get_my_user_id();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: usuario no autenticado';
  END IF;
  SELECT tenant_id INTO v_tenant FROM usuarios WHERE id = v_actor AND rol = 'miembro';
  IF v_tenant IS NULL OR v_tenant <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo un socio puede cancelar su plan';
  END IF;

  v_res := _cancelar_plan_por_cobrar(v_actor, 'Cancelado por el socio desde la app (no pagado)');
  IF COALESCE((v_res->>'plan_cancelado')::boolean, false) IS NOT TRUE THEN
    CASE v_res->>'reason'
      WHEN 'sin_membresia' THEN
        RAISE EXCEPTION 'SIN_PLAN: no tienes un plan activo que cancelar';
      WHEN 'tiene_pagos', 'tiene_stripe' THEN
        RAISE EXCEPTION 'PLAN_PAGADO: tu plan ya tiene pagos registrados; para cancelarlo habla con recepción';
      WHEN 'sin_cargo_plan' THEN
        RAISE EXCEPTION 'NO_POR_COBRAR: tu plan no está pendiente de pago; para cancelarlo habla con recepción';
      ELSE
        RAISE EXCEPTION 'NO_SE_PUDO: no pudimos cancelar tu plan, intenta de nuevo';
    END CASE;
  END IF;
  RETURN v_res;
END;
$$;
REVOKE ALL ON FUNCTION socio_cancelar_plan_por_cobrar() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION socio_cancelar_plan_por_cobrar() TO authenticated;
COMMENT ON FUNCTION socio_cancelar_plan_por_cobrar() IS
  'El socio cancela su propio plan "por cobrar" (elegido con "Pagar en recepción" y nunca pagado). Reservas futuras liberadas, cargos cancelados; la prueba se libera si no la tomó.';

-- ── D) cobro de pendientes vía Stripe (webhook, service_role) ────────────────
CREATE OR REPLACE FUNCTION stripe_cobrar_cargos_pendientes(
  p_event_id text,
  p_cargo_ids uuid[],
  p_referencia text,
  p_account_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
  v_cargo cargos_pendientes;
  v_id uuid;
  v_pago_id uuid;
  v_cobrados jsonb := '[]'::jsonb;
  v_no_aplicados jsonb := '[]'::jsonb;
  v_reembolsar integer := 0;
  v_total integer := 0;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE stripe_account_id = p_account_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'STRIPE_CUENTA_DESCONOCIDA: ninguna cuenta conectada %', p_account_id;
  END IF;

  -- Idempotencia por referencia (payment_intent): un replay NO duplica pagos.
  IF EXISTS (SELECT 1 FROM pagos WHERE tenant_id = v_tenant AND referencia = p_referencia AND metodo = 'stripe') THEN
    PERFORM _stripe_inbox_processed(p_event_id);
    RETURN jsonb_build_object('ok', true, 'replay', true, 'reembolsar_centavos', 0);
  END IF;

  FOREACH v_id IN ARRAY p_cargo_ids LOOP
    SELECT * INTO v_cargo FROM cargos_pendientes WHERE id = v_id AND tenant_id = v_tenant FOR UPDATE;
    IF v_cargo.id IS NULL THEN
      v_no_aplicados := v_no_aplicados || jsonb_build_object('cargo_id', v_id, 'estado', 'inexistente', 'monto_centavos', 0);
      CONTINUE;
    END IF;
    IF v_cargo.estado <> 'pendiente' THEN
      -- Ya lo cobró recepción (o se canceló el plan) mientras la socia pagaba:
      -- NO se registra doble; el webhook reembolsa este monto.
      v_no_aplicados := v_no_aplicados || jsonb_build_object('cargo_id', v_id, 'estado', v_cargo.estado, 'monto_centavos', v_cargo.monto_centavos);
      v_reembolsar := v_reembolsar + v_cargo.monto_centavos;
      CONTINUE;
    END IF;

    INSERT INTO pagos (
      tenant_id, sucursal_id, usuario_id, concepto, monto_centavos, moneda, metodo, referencia, notas, cobrado_por
    ) VALUES (
      v_cargo.tenant_id, v_cargo.sucursal_id, v_cargo.usuario_id, v_cargo.concepto,
      v_cargo.monto_centavos, v_cargo.moneda, 'stripe', p_referencia,
      'Cobro de pendiente (tarjeta, app)' || COALESCE(' · ' || v_cargo.descripcion, ''), NULL
    )
    RETURNING id INTO v_pago_id;

    UPDATE cargos_pendientes
    SET estado = 'cobrado', pago_id = v_pago_id, cobrado_at = now()
    WHERE id = v_cargo.id;

    v_total := v_total + v_cargo.monto_centavos;
    v_cobrados := v_cobrados || jsonb_build_object('cargo_id', v_cargo.id, 'pago_id', v_pago_id, 'monto_centavos', v_cargo.monto_centavos);
  END LOOP;

  PERFORM _stripe_inbox_processed(p_event_id);
  RETURN jsonb_build_object(
    'ok', true, 'tenant_id', v_tenant, 'cobrados', v_cobrados, 'no_aplicados', v_no_aplicados,
    'total_cobrado_centavos', v_total, 'reembolsar_centavos', v_reembolsar
  );
END;
$$;
REVOKE ALL ON FUNCTION stripe_cobrar_cargos_pendientes(text, uuid[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION stripe_cobrar_cargos_pendientes(text, uuid[], text, text) TO service_role;
COMMENT ON FUNCTION stripe_cobrar_cargos_pendientes(text, uuid[], text, text) IS
  'Webhook (service_role): asienta como pagos metodo stripe los cargos pendientes que la socia pagó con tarjeta desde la app. Lo ya cobrado/cancelado no se duplica: vuelve en reembolsar_centavos para que el webhook lo devuelva.';

-- ── Self-test (devuelve tabla; se revierte solo) ────────────────────────────
DO $$
DECLARE
  v_tenant uuid;
  v_tier uuid;
  v_socio uuid;
  v_mem uuid;
  v_cargo uuid;
  v_res jsonb;
  v_status text;
  v_estado text;
  v_prueba integer;
BEGIN
  SELECT t.tenant_id, t.id INTO v_tenant, v_tier
  FROM tiers t
  WHERE t.activo = true AND t.en_venta = true AND COALESCE(t.es_prueba, false) = true
  LIMIT 1;
  IF v_tier IS NULL THEN
    RAISE NOTICE 'SELF-TEST SKIP: no hay tier de prueba';
    RETURN;
  END IF;

  INSERT INTO usuarios (tenant_id, rol, nombre, email, status)
  VALUES (v_tenant, 'miembro', 'Self-test por cobrar', 'selftest-porcobrar-' || gen_random_uuid()::text || '@example.com', 'activo')
  RETURNING id INTO v_socio;

  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
  VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now() + interval '7 days', 1)
  RETURNING id INTO v_mem;

  INSERT INTO cargos_pendientes (tenant_id, usuario_id, concepto, descripcion, monto_centavos)
  VALUES (v_tenant, v_socio, 'plan', 'self-test', 9900)
  RETURNING id INTO v_cargo;

  SELECT count(*) INTO v_prueba FROM pruebas_usadas WHERE usuario_id = v_socio;
  IF v_prueba <> 1 THEN RAISE EXCEPTION 'SELF-TEST: el trigger no marcó la prueba'; END IF;

  v_res := _cancelar_plan_por_cobrar(v_socio, 'self-test');
  IF COALESCE((v_res->>'plan_cancelado')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'SELF-TEST: no canceló el plan por cobrar (%)', v_res;
  END IF;
  SELECT status INTO v_status FROM membresias WHERE id = v_mem;
  SELECT estado INTO v_estado FROM cargos_pendientes WHERE id = v_cargo;
  SELECT count(*) INTO v_prueba FROM pruebas_usadas WHERE usuario_id = v_socio;
  IF v_status <> 'cancelada' THEN RAISE EXCEPTION 'SELF-TEST: membresía quedó %', v_status; END IF;
  IF v_estado <> 'cancelado' THEN RAISE EXCEPTION 'SELF-TEST: cargo quedó %', v_estado; END IF;
  IF v_prueba <> 0 THEN RAISE EXCEPTION 'SELF-TEST: la prueba no se liberó'; END IF;

  -- Con pago registrado NO debe tocar la membresía.
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
  VALUES (v_tenant, v_socio, v_tier, 'activa', now(), now() + interval '7 days', 1)
  RETURNING id INTO v_mem;
  INSERT INTO pagos (tenant_id, usuario_id, membresia_id, tier_id, concepto, monto_centavos, moneda, metodo)
  VALUES (v_tenant, v_socio, v_mem, v_tier, 'paquete', 9900, 'MXN', 'efectivo');
  INSERT INTO cargos_pendientes (tenant_id, usuario_id, concepto, descripcion, monto_centavos)
  VALUES (v_tenant, v_socio, 'plan', 'self-test 2', 9900);
  v_res := _cancelar_plan_por_cobrar(v_socio, 'self-test');
  IF (v_res->>'reason') IS DISTINCT FROM 'tiene_pagos' THEN
    RAISE EXCEPTION 'SELF-TEST: con pagos debió responder tiene_pagos (%)', v_res;
  END IF;
  SELECT status INTO v_status FROM membresias WHERE id = v_mem;
  IF v_status <> 'activa' THEN RAISE EXCEPTION 'SELF-TEST: tocó una membresía pagada'; END IF;

  RAISE EXCEPTION 'SELF-TEST OK (rollback intencional)';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'SELF-TEST OK%' THEN
      RAISE NOTICE '%', SQLERRM;
    ELSE
      RAISE;
    END IF;
END $$;

-- ── Verificación (devuelve tabla) ───────────────────────────────────────────
SELECT p.proname AS funcion,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_puede,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_puede,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_puede
FROM pg_proc p
WHERE p.proname IN ('_cancelar_plan_por_cobrar', 'cancelar_cargo_pendiente',
                    'socio_cancelar_plan_por_cobrar', 'stripe_cobrar_cargos_pendientes')
ORDER BY p.proname;
