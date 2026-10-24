-- ============================================================================
-- La clase se cuenta en el plan vigente, no en un plan "por cobrar" cancelado
-- ============================================================================
-- Caso The Core (23-oct-2026, Betsaida Beltrán): recepción le dio de alta la
-- Clase prueba "por cobrar" ($99) el 21-oct y la anotó en POLE FITNESS del
-- 23-oct 08:30 (walk-in). La reserva debitó el único crédito de la prueba. El
-- 23-oct en mostrador prefirió no pagar la prueba y comprar el Paquete 12:
-- recepción canceló el cargo (→ _cancelar_plan_por_cobrar canceló la membresía
-- de prueba) y asignó paq-12 ($1,650). Al marcar su asistencia la reserva
-- seguía colgada de la membresía de prueba cancelada: la clase "salió" de la
-- prueba que nunca pagó y el paquete quedó en 12/12.
--
-- Tres huecos:
--   1) La reserva de una clase YA INICIADA no se libera al cancelar el plan (no
--      debe: la socia la va a tomar) pero nadie la re-cobraba al plan nuevo.
--   2) _liberar_reservas_membresia respeta las reservas que SÍ debitaron crédito
--      (crédito pagado = la reserva sobrevive). En un plan por cobrar cancelado
--      el crédito nunca se pagó: esas reservas futuras también deben caer (la UI
--      ya prometía "se liberan sus reservas futuras").
--   3) Si recepción asigna el plan nuevo ANTES de cancelar el cargo, gestionar_
--      membresia_socio reutiliza la MISMA fila de membresía: el crédito no pagado
--      de la prueba queda consumido por la reserva y el paquete íntegro. Mismo
--      resultado por otro camino.
--
-- Qué hace esta migración:
--   A) _reserva_trasladar_a_plan_vigente(reserva, actor): si la reserva nació de
--      una membresía CANCELADA que nunca tuvo pagos y cuyo cargo de plan se
--      canceló (= por cobrar cancelado), la re-cuelga del plan vigente del socio
--      y, si ese plan es por créditos, debita ahí el mismo costo que debitó la
--      original (1 + invitados). Sin saldo → SIN_CREDITOS_TRASLADO. Un plan
--      pagado y cancelado (baja, reembolso) NO se re-cobra.
--   B) _cancelar_plan_por_cobrar: además de _liberar_reservas_membresia, cancela
--      las reservas FUTURAS confirmadas aunque hayan debitado crédito. Las ya
--      iniciadas se quedan (se cobran al plan vigente al marcar asistencia).
--      Devuelve reservas_liberadas y reservas_en_curso para que la UI lo diga.
--   C) gestionar_membresia_socio: PLAN_POR_COBRAR_PENDIENTE si el socio tiene un
--      cargo de plan pendiente. Recepción cobra o cancela primero.
--   D) check_in_atomic (QR), check_in_manual_atomic, check_in_por_huella y
--      admin_marcar_asistencia llaman al traslado justo antes de marcar presente
--      y devuelven 'traslado' en su resultado/bitácora.
--
-- Orden de locks: el traslado toma M (plan vigente) y lo llaman funciones que
-- ya tienen R (y X en la restauración de asistencia): R → X → M se respeta.
-- Corrección del dato de Betsaida: scripts/fix_betsaida_traslado_paq12.sql
-- (usa este mismo helper). Pruebas: scripts/test_reserva_sigue_plan_vigente.sql.
-- ============================================================================

-- ── A) traslado de una reserva al plan vigente ──────────────────────────────
CREATE OR REPLACE FUNCTION _reserva_trasladar_a_plan_vigente(p_reserva_id uuid, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_r reservas;
  v_old membresias;
  v_new membresias;
  v_tier tiers;
  v_tier_old_nombre text;
  v_costo integer := 0;
  v_saldo integer;
  v_motivo text;
BEGIN
  -- El caller ya tiene R (FOR UPDATE de la reserva); acá solo se lee.
  SELECT * INTO v_r FROM reservas WHERE id = p_reserva_id;
  IF v_r.id IS NULL OR v_r.membresia_id IS NULL
     OR COALESCE(v_r.entitlement_source, 'membership') <> 'membership' THEN
    RETURN jsonb_build_object('trasladada', false, 'reason', 'no_aplica');
  END IF;

  SELECT * INTO v_old FROM membresias WHERE id = v_r.membresia_id;
  IF v_old.id IS NULL OR v_old.status <> 'cancelada' THEN
    RETURN jsonb_build_object('trasladada', false, 'reason', 'plan_origen_vigente');
  END IF;

  -- ¿Fue un plan "por cobrar" cancelado sin pagar? Dos evidencias: cero pagos de
  -- plan/paquete ligados a esa membresía Y un cargo de plan CANCELADO registrado
  -- entre su alta y su cancelación. Un plan pagado que se dio de baja NO entra:
  -- su crédito sí se pagó y no se vuelve a cobrar en el plan nuevo.
  IF EXISTS (
    SELECT 1 FROM pagos p
    WHERE p.membresia_id = v_old.id AND p.concepto IN ('plan', 'paquete')
  ) THEN
    RETURN jsonb_build_object('trasladada', false, 'reason', 'plan_origen_pagado');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cargos_pendientes c
    WHERE c.usuario_id = v_old.usuario_id
      AND c.concepto = 'plan'
      AND c.estado = 'cancelado'
      AND c.created_at >= v_old.created_at - interval '10 minutes'
      AND c.created_at <= COALESCE(v_old.cancelada_at, now())
  ) THEN
    RETURN jsonb_build_object('trasladada', false, 'reason', 'sin_cargo_cancelado');
  END IF;

  -- M: plan vigente del socio (distinto del cancelado). Lock: vamos a debitar.
  SELECT m.* INTO v_new
  FROM membresias m
  WHERE m.usuario_id = v_r.usuario_id
    AND m.id <> v_old.id
    AND m.status IN ('activa', 'trialing', 'past_due')
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF v_new.id IS NULL THEN
    RETURN jsonb_build_object('trasladada', false, 'reason', 'sin_plan_vigente');
  END IF;

  SELECT * INTO v_tier FROM tiers WHERE id = v_new.tier_id;
  SELECT t.nombre INTO v_tier_old_nombre FROM tiers t WHERE t.id = v_old.tier_id;

  IF v_tier.tipo IN ('creditos', 'hibrido') THEN
    -- Mismo costo que debitó la original (evidencia del ledger); si no hubo
    -- débito (plan ilimitado de origen), 1 + invitados como reservar_clase_atomic.
    SELECT -mm.delta_creditos INTO v_costo
    FROM membresia_movimientos mm
    WHERE mm.reserva_id = v_r.id AND mm.membresia_id = v_old.id AND mm.tipo = 'debito'
    ORDER BY mm.created_at, mm.id
    LIMIT 1;
    v_costo := COALESCE(v_costo, 1 + COALESCE(v_r.invitados_count, 0));

    IF v_costo > 0 THEN
      IF COALESCE(v_new.creditos_restantes, 0) < v_costo THEN
        RAISE EXCEPTION 'SIN_CREDITOS_TRASLADO: Esta clase se reservó con un plan que se canceló sin pagar (%). Para contarla en su plan actual (%) hace(n) falta % clase(s) y le queda(n) %',
          COALESCE(v_tier_old_nombre, 'plan anterior'), v_tier.nombre, v_costo, COALESCE(v_new.creditos_restantes, 0);
      END IF;
      v_motivo := format('clase %s trasladada al plan vigente (%s): se reservó con "%s", plan por cobrar cancelado sin pagar',
                         v_r.folio, v_tier.nombre, COALESCE(v_tier_old_nombre, 'plan anterior'));
      v_saldo := _aplicar_credito(v_new.id, -v_costo, 'debito', v_motivo, v_r.id, NULL, p_actor);
    END IF;
  ELSE
    v_costo := 0;
  END IF;

  UPDATE reservas SET membresia_id = v_new.id WHERE id = v_r.id;

  RETURN jsonb_build_object(
    'trasladada', true,
    'de_membresia_id', v_old.id,
    'de_tier', v_tier_old_nombre,
    'a_membresia_id', v_new.id,
    'a_tier', v_tier.nombre,
    'creditos', v_costo,
    'saldo', v_saldo
  );
END;
$$;
REVOKE ALL ON FUNCTION _reserva_trasladar_a_plan_vigente(uuid, uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION _reserva_trasladar_a_plan_vigente(uuid, uuid) IS
  'Interno (check-ins). Si la reserva nació de un plan por cobrar que se canceló sin pagar, la re-cuelga del plan vigente del socio y debita ahí su costo. Devuelve trasladada=false con reason si no aplica; SIN_CREDITOS_TRASLADO si el plan vigente no alcanza.';

-- ── B) _cancelar_plan_por_cobrar: también caen las reservas futuras con crédito ──
-- Cuerpo vigente de 20261022230000 + liberación de futuras debitadas + conteos.
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
  v_futuras integer := 0;
  v_en_curso integer := 0;
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

  -- Reservas futuras confirmadas de este plan: todas caen (ver abajo).
  SELECT count(*) INTO v_futuras
  FROM reservas r
  WHERE r.membresia_id = v_mem.id AND r.status = 'confirmada' AND r.slot_inicio > now();

  UPDATE membresias
  SET status = 'cancelada', cancelada_at = now(), updated_at = now()
  WHERE id = v_mem.id;

  -- Cache: el trigger de W5-B también lo limpia; se mantiene por robustez.
  UPDATE usuarios
  SET membresia_tier = NULL, membresia_activa_id = NULL
  WHERE id = p_usuario_id;

  -- Perdió el entitlement: sus reservas futuras se liberan sin débito.
  PERFORM _liberar_reservas_membresia(v_mem.id);

  -- _liberar_reservas_membresia respeta las reservas que SÍ debitaron crédito
  -- (crédito pagado = la reserva sobrevive al fin del plan). Aquí el crédito
  -- nunca se pagó: también caen. Las clases YA INICIADAS se quedan (la socia
  -- puede estar tomándola): al marcar asistencia se cobran al plan que tenga
  -- vigente (_reserva_trasladar_a_plan_vigente).
  UPDATE reservas r
  SET status = 'cancelada_admin',
      cancelada_at = now(),
      cancelada_motivo = 'sistema_fin_entitlement: plan por cobrar cancelado sin pagar (membresía ' || v_mem.id::text || ')'
  WHERE r.membresia_id = v_mem.id
    AND r.status = 'confirmada'
    AND r.slot_inicio > now();

  SELECT count(*) INTO v_en_curso
  FROM reservas r
  WHERE r.membresia_id = v_mem.id
    AND r.status IN ('confirmada', 'no_show')
    AND r.slot_inicio <= now()
    AND r.slot_fin >= now() - interval '12 hours';

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
                         'prueba_liberada', v_prueba_liberada,
                         'reservas_liberadas', v_futuras, 'reservas_en_curso', v_en_curso)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'plan_cancelado', true,
    'membresia_id', v_mem.id,
    'tier_nombre', v_tier.nombre,
    'cargos_cancelados', v_cargos,
    'prueba_liberada', v_prueba_liberada,
    'reservas_liberadas', v_futuras,
    'reservas_en_curso', v_en_curso
  );
END;
$$;
REVOKE ALL ON FUNCTION _cancelar_plan_por_cobrar(uuid, text) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION _cancelar_plan_por_cobrar(uuid, text) IS
  'Interno. Cancela la membresía actual del socio si está "por cobrar" (cargo de plan pendiente y cero pagos): status cancelada, TODAS sus reservas futuras liberadas (con o sin débito: el crédito nunca se pagó), cargos de plan/inscripción cancelados, prueba liberada si no la tomó. Las clases ya iniciadas se quedan y se cobran al plan vigente al marcar asistencia. Devuelve plan_cancelado=false con reason si no aplica.';

-- ── C) gestionar_membresia_socio: candado contra encimar un plan sobre uno por cobrar ──
-- Cuerpo vigente de 20261022100000 + el candado PLAN_POR_COBRAR_PENDIENTE.
CREATE OR REPLACE FUNCTION public.gestionar_membresia_socio(p_usuario_id uuid, p_tier_id uuid, p_motivo text DEFAULT NULL::text, p_metodo_pago text DEFAULT NULL::text, p_monto_centavos integer DEFAULT NULL::integer, p_confirmar_perdida boolean DEFAULT false, p_operation_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor_id uuid;
  v_actor_tenant_id uuid;
  v_socio usuarios;
  v_tier tiers;
  v_now timestamptz := now();
  v_anterior_id uuid;
  v_anterior_fin timestamptz;
  v_anterior_saldo integer;
  v_anterior_tier_tipo text;
  v_anterior_es_pase boolean;
  v_anterior_sucursal_id uuid;
  v_existe_anterior boolean := false;
  v_mismo_tipo boolean := false;
  v_nuevo_fin timestamptz;
  v_nuevo_saldo integer;
  v_modo text;
  v_delta_creditos integer;
  v_membresia_id uuid;
  v_motivo_final text;
  v_monto_plan integer;
  v_cobra_inscripcion boolean := false;
  v_inscripcion integer := 0;
  v_sucursal_id uuid;
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
  v_precio jsonb;
  v_desc_centavos integer := 0;
  v_desc_etiqueta text;
  v_pc_desc text;
  v_pc_monto integer;
BEGIN
  v_actor_id := get_my_user_id();
  v_actor_tenant_id := get_my_tenant_id();
  IF v_actor_id IS NULL OR v_actor_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  -- Autoservicio (socio_activar_plan_por_cobrar) entra con la bandera local a la tx.
  IF NOT (is_recepcionista() OR _autoservicio_plan_on()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff (admin/recepción) puede gestionar membresías';
  END IF;

  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_actor_tenant_id, p_operation_key, 'membresia', v_actor_id,
      md5(jsonb_build_object('usuario', p_usuario_id, 'tier', p_tier_id, 'motivo', p_motivo,
                             'metodo', p_metodo_pago, 'monto', p_monto_centavos,
                             'confirmar', p_confirmar_perdida)::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE: El socio no existe';
  END IF;
  IF v_socio.tenant_id <> v_actor_tenant_id THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: El socio no pertenece a tu gimnasio';
  END IF;
  IF v_socio.rol <> 'miembro' THEN
    RAISE EXCEPTION 'ROL_INVALIDO: Solo se pueden asignar membresías a usuarios con rol miembro';
  END IF;

  SELECT * INTO v_tier FROM tiers WHERE id = p_tier_id;
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE: El tier no existe';
  END IF;
  IF v_tier.tenant_id <> v_socio.tenant_id THEN
    RAISE EXCEPTION 'TIER_TENANT_INVALIDO: El tier no pertenece al mismo gimnasio que el socio';
  END IF;
  IF NOT v_tier.activo THEN
    RAISE EXCEPTION 'TIER_INACTIVO: El tier no está activo. Activalo desde Planes antes de asignarlo';
  END IF;

  IF p_metodo_pago IS NOT NULL
     AND p_metodo_pago NOT IN ('efectivo', 'tarjeta', 'transferencia', 'cortesia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: Método de pago no válido (%)', p_metodo_pago;
  END IF;

  -- Plan "por cobrar" sin resolver: no se le encima otro plan. Si se hiciera, el
  -- plan nuevo reutilizaría la MISMA fila de membresía y el crédito nunca pagado
  -- del plan anterior quedaría consumido gratis (una clase de prueba por cobrar +
  -- paquete encima = la clase sale de la prueba, no del paquete). Recepción primero
  -- cobra o cancela el pendiente en "Por cobrar" (cancelarlo cancela el plan).
  SELECT string_agg(NULLIF(trim(c.descripcion), ''), ', '), sum(c.monto_centavos)
    INTO v_pc_desc, v_pc_monto
  FROM cargos_pendientes c
  WHERE c.usuario_id = p_usuario_id AND c.estado = 'pendiente' AND c.concepto = 'plan';
  IF v_pc_monto IS NOT NULL THEN
    RAISE EXCEPTION 'PLAN_POR_COBRAR_PENDIENTE: El socio tiene un plan por cobrar sin pagar (% · $%). Cóbralo o cancélalo en "Por cobrar" antes de asignarle otro plan',
      COALESCE(v_pc_desc, 'plan'), to_char(v_pc_monto / 100.0, 'FM999G999G990D00');
  END IF;

  SELECT m.id, m.periodo_actual_fin, m.creditos_restantes, t.tipo, COALESCE(t.es_pase, false), m.sucursal_id
  INTO v_anterior_id, v_anterior_fin, v_anterior_saldo, v_anterior_tier_tipo, v_anterior_es_pase, v_anterior_sucursal_id
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada', 'expirada')
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  v_existe_anterior := v_anterior_id IS NOT NULL;
  v_mismo_tipo := v_existe_anterior AND v_anterior_tier_tipo = v_tier.tipo;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  IF v_existe_anterior THEN
    PERFORM _guard_sucursal_recepcion(v_anterior_sucursal_id);
  ELSE
    PERFORM _guard_sucursal_recepcion(v_socio.sucursal_id);
  END IF;

  IF NOT v_existe_anterior THEN
    v_modo := 'alta';
    v_nuevo_fin := CASE
      WHEN v_tier.duracion_dias IS NULL THEN NULL
      ELSE v_now + (v_tier.duracion_dias || ' days')::interval
    END;
    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE v_tier.clases_incluidas
    END;
  ELSIF v_mismo_tipo THEN
    IF v_tier.duracion_dias IS NULL THEN
      v_nuevo_fin := NULL;
      v_modo := 'renovacion';
    ELSIF NOT COALESCE(v_tier.es_pase, false)
          AND NOT COALESCE(v_anterior_es_pase, false)
          AND v_anterior_fin IS NOT NULL AND v_anterior_fin > v_now THEN
      v_nuevo_fin := v_anterior_fin + (v_tier.duracion_dias || ' days')::interval;
      v_modo := 'renovacion';
    ELSE
      v_nuevo_fin := v_now + (v_tier.duracion_dias || ' days')::interval;
      v_modo := 'renovacion_desde_hoy';
    END IF;
    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE COALESCE(v_anterior_saldo, 0) + COALESCE(v_tier.clases_incluidas, 0)
    END;
  ELSE
    v_modo := 'cambio_de_tipo';
    v_nuevo_fin := CASE
      WHEN v_tier.duracion_dias IS NULL THEN NULL
      ELSE v_now + (v_tier.duracion_dias || ' days')::interval
    END;
    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE v_tier.clases_incluidas
    END;
  END IF;

  v_delta_creditos := COALESCE(v_nuevo_saldo, 0) - COALESCE(v_anterior_saldo, 0);

  IF v_modo = 'cambio_de_tipo'
     AND COALESCE(v_anterior_saldo, 0) > 0
     AND NOT COALESCE(p_confirmar_perdida, false) THEN
    RAISE EXCEPTION
      'CREDITOS_SE_PIERDEN: El socio tiene % clase(s) sin usar. Cambiar a este plan las borra. Confirmá el cambio si es lo que querés.',
      v_anterior_saldo;
  END IF;

  IF v_existe_anterior THEN
    UPDATE membresias
    SET tier_id = p_tier_id,
        status = 'activa',
        periodo_actual_inicio = v_now,
        periodo_actual_fin = v_nuevo_fin,
        creditos_restantes = v_nuevo_saldo,
        updated_at = v_now
    WHERE id = v_anterior_id;
    v_membresia_id := v_anterior_id;
  ELSE
    INSERT INTO membresias (
      tenant_id, usuario_id, tier_id, status,
      periodo_actual_inicio, periodo_actual_fin, creditos_restantes
    ) VALUES (
      v_socio.tenant_id, p_usuario_id, p_tier_id, 'activa',
      v_now, v_nuevo_fin, v_nuevo_saldo
    )
    RETURNING id INTO v_membresia_id;
  END IF;

  v_motivo_final := COALESCE(
    NULLIF(trim(p_motivo), ''),
    format('%s — tier %s', v_modo, v_tier.slug)
  );

  IF v_modo = 'cambio_de_tipo' AND COALESCE(v_anterior_saldo, 0) > 0 THEN
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'expiracion', -v_anterior_saldo,
      NULL, format('créditos perdidos por cambio de plan (tier %s)', v_tier.slug), v_actor_id
    );
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'alta', COALESCE(v_nuevo_saldo, 0),
      NULL, v_motivo_final, v_actor_id
    );
  ELSE
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'alta', v_delta_creditos,
      NULL, v_motivo_final, v_actor_id
    );
  END IF;

  IF p_metodo_pago IS NOT NULL THEN
    -- Descuento por socio (p. ej. Estudiante -20%): se aplica al PLAN, nunca a la
    -- inscripción. Solo si nadie mandó un monto explícito (p_monto_centavos manda).
    IF p_monto_centavos IS NULL THEN
      v_precio := _precio_plan_para_socio(p_usuario_id, p_tier_id, 'recepcion');
      v_monto_plan := COALESCE((v_precio->>'precio_final_centavos')::integer, v_tier.precio_centavos, 0);
      v_desc_centavos := COALESCE((v_precio->>'descuento_centavos')::integer, 0);
      v_desc_etiqueta := v_precio->>'etiqueta';
    ELSE
      v_monto_plan := p_monto_centavos;
    END IF;
    SELECT sucursal_id INTO v_sucursal_id FROM membresias WHERE id = v_membresia_id;

    IF v_monto_plan > 0 THEN
      INSERT INTO pagos (
        tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
        concepto, monto_centavos, moneda, metodo, notas, cobrado_por
      ) VALUES (
        v_socio.tenant_id, v_sucursal_id, p_usuario_id, v_membresia_id, p_tier_id,
        CASE WHEN v_tier.tipo IN ('creditos', 'hibrido') THEN 'paquete' ELSE 'plan' END,
        v_monto_plan, COALESCE(v_tier.moneda, 'MXN'), p_metodo_pago,
        v_motivo_final || COALESCE(' · ' || v_desc_etiqueta, ''), v_actor_id
      );
    END IF;

    v_inscripcion := COALESCE(v_tier.inscripcion_centavos, 0);
    v_cobra_inscripcion := v_inscripcion > 0
      AND v_socio.inscripcion_pagada_at IS NULL
      AND v_modo = 'alta'
      AND NOT EXISTS (
        SELECT 1 FROM membresias
        WHERE usuario_id = p_usuario_id AND id <> v_membresia_id
      );

    IF v_cobra_inscripcion THEN
      INSERT INTO pagos (
        tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
        concepto, monto_centavos, moneda, metodo, notas, cobrado_por
      ) VALUES (
        v_socio.tenant_id, v_sucursal_id, p_usuario_id, v_membresia_id, p_tier_id,
        'inscripcion', v_inscripcion, COALESCE(v_tier.moneda, 'MXN'), p_metodo_pago,
        'inscripción', v_actor_id
      );
      UPDATE usuarios SET inscripcion_pagada_at = v_now WHERE id = p_usuario_id;
    END IF;
  END IF;

  UPDATE usuarios
  SET membresia_tier = v_tier.slug,
      membresia_activa_id = v_membresia_id,
      status = CASE WHEN status = 'pendiente_pago' THEN 'activo' ELSE status END
  WHERE id = p_usuario_id;

  v_result := jsonb_build_object(
    'success', true,
    'membresia_id', v_membresia_id,
    'modo', v_modo,
    'tier_slug', v_tier.slug,
    'tier_nombre', v_tier.nombre,
    'tier_tipo', v_tier.tipo,
    'periodo_actual_fin', v_nuevo_fin,
    'creditos_restantes', v_nuevo_saldo,
    'delta_creditos', v_delta_creditos,
    'cobro_registrado', p_metodo_pago IS NOT NULL,
    'monto_plan_centavos', COALESCE(v_monto_plan, 0),
    'descuento_centavos', v_desc_centavos,
    'descuento_etiqueta', v_desc_etiqueta,
    'inscripcion_centavos', CASE WHEN v_cobra_inscripcion THEN v_inscripcion ELSE 0 END
  );
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_actor_tenant_id, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$function$;

-- ── D) check-ins: la clase se cuenta en el plan vigente ─────────────────────
-- Cuerpos vigentes (QR 20260928140000, manual 20261022100000, huella
-- 20260928160000, marcar asistencia 20261007120000) + llamada al traslado justo
-- antes de marcar presente. Privilegios: CREATE OR REPLACE los conserva.

-- D.1 QR
CREATE OR REPLACE FUNCTION check_in_atomic(p_reserva_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_rol text;
  v_caller_status text;
  v_reserva reservas;
  v_miembro usuarios;
  v_recurso recursos;
  v_now timestamptz := now();
  v_ventana_min integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
  v_check_ins_hoy integer;
  v_check_ins_semana integer;
  v_inicio_semana timestamptz;
  v_traslado jsonb;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  -- W3-02: autorización status-aware. El rol cacheado del helper NO filtra status
  -- → un staff revocado con JWT vivo pasaba. Leemos rol+status del caller y
  -- exigimos status='activo'.
  SELECT rol, status INTO v_rol, v_caller_status FROM usuarios WHERE id = v_user_id;
  IF v_rol IS NULL OR v_rol NOT IN ('admin', 'recepcionista', 'staff') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff puede hacer check-in';
  END IF;
  IF v_caller_status IS DISTINCT FROM 'activo' THEN
    RAISE EXCEPTION 'CUENTA_INACTIVA: tu acceso fue revocado o desactivado';
  END IF;

  -- W2-03: FOR UPDATE serializa el check-in de ESTA reserva.
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  PERFORM _guard_sucursal_staff(v_reserva.recurso_id);

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este miembro ya hizo check-in (% UTC)', v_reserva.check_in_at;
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'RESERVA_CANCELADA: Esta reserva fue cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'RESERVA_NO_SHOW: Esta reserva fue marcada como inasistencia';
  END IF;

  PERFORM _guard_membresia_checkin(v_reserva.usuario_id);

  v_ventana_min := ventana_check_in_min(v_tenant_id);
  v_ventana_inicio := v_reserva.slot_inicio - (v_ventana_min || ' minutes')::interval;
  v_ventana_fin := v_reserva.slot_fin + (v_ventana_min * 2 || ' minutes')::interval;

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'DEMASIADO_TEMPRANO: El check-in abre % min antes (a las %)',
      v_ventana_min, to_char(v_ventana_inicio, 'HH24:MI');
  END IF;

  IF v_now > v_ventana_fin THEN
    RAISE EXCEPTION 'DEMASIADO_TARDE: El check-in cerró a las %',
      to_char(v_ventana_fin, 'HH24:MI');
  END IF;

  -- La reserva pudo nacer de un plan "por cobrar" que se canceló sin pagar
  -- (caso Betsaida, The Core 23-oct-2026): su crédito nunca existió. Antes de
  -- marcar presente se traslada al plan vigente del socio y se cobra ahí
  -- (SIN_CREDITOS_TRASLADO si no alcanza). Si no aplica, devuelve el motivo.
  v_traslado := _reserva_trasladar_a_plan_vigente(p_reserva_id, v_user_id);

  UPDATE reservas
  SET status = 'completada',
      check_in_at = v_now,
      check_in_by = v_user_id,
      check_in_method = 'qr'
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;
  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;

  v_inicio_semana := date_trunc('week', v_now);

  SELECT count(*) INTO v_check_ins_hoy
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= date_trunc('day', v_now);

  SELECT count(*) INTO v_check_ins_semana
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= v_inicio_semana;

  IF v_rol IN ('recepcionista', 'admin') THEN
    PERFORM _audrec_log(
      'checkin.qr', 'reserva', p_reserva_id, v_reserva.usuario_id, v_miembro.nombre,
      format('Check-in QR de %s', to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI')),
      jsonb_build_object('method', 'qr', 'traslado', v_traslado)
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva', row_to_json(v_reserva),
    'miembro', jsonb_build_object(
      'id', v_miembro.id,
      'nombre', v_miembro.nombre,
      'email', v_miembro.email,
      'telefono', v_miembro.telefono,
      'avatar_url', v_miembro.avatar_url,
      'membresia_tier', v_miembro.membresia_tier,
      'notas_admin', v_miembro.notas_admin
    ),
    'recurso', jsonb_build_object(
      'id', v_recurso.id,
      'nombre', v_recurso.nombre
    ),
    'membresia_estado', _estado_membresia_checkin(v_reserva.usuario_id),
    'traslado', v_traslado,
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION check_in_atomic(uuid) TO authenticated;

-- D.2 manual (recepción)
CREATE OR REPLACE FUNCTION check_in_manual_atomic(
  p_reserva_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_rol text;
  v_caller_status text;
  v_reserva reservas;
  v_miembro usuarios;
  v_recurso recursos;
  v_now timestamptz := now();
  v_ventana_min integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
  v_check_ins_hoy integer;
  v_check_ins_semana integer;
  v_inicio_semana timestamptz;
  v_traslado jsonb;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  -- W3-02: autorización status-aware (ver check_in_atomic).
  SELECT rol, status INTO v_rol, v_caller_status FROM usuarios WHERE id = v_user_id;
  IF v_rol IS NULL OR v_rol NOT IN ('admin', 'recepcionista', 'staff') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff puede hacer check-in';
  END IF;
  IF v_caller_status IS DISTINCT FROM 'activo' THEN
    RAISE EXCEPTION 'CUENTA_INACTIVA: tu acceso fue revocado o desactivado';
  END IF;

  -- W2-03: FOR UPDATE (ver check_in_atomic).
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  PERFORM _guard_sucursal_staff(v_reserva.recurso_id);

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este miembro ya hizo check-in';
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'RESERVA_CANCELADA: Reserva cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'RESERVA_NO_SHOW: Reserva marcada como inasistencia';
  END IF;
  -- Bloqueo duro por pago pendiente (plan activado "por cobrar", desde la app o
  -- el mostrador): no entra hasta que recepción lo cobre (botón Cobrar en el
  -- check-in / Por cobrar). Mismo criterio que QR y huella.
  PERFORM _guard_pago_pendiente_checkin(v_reserva.usuario_id);

  -- OJO: acá NO bloqueamos por membresía (política: recepción decide).

  v_ventana_min := ventana_check_in_min(v_tenant_id);
  v_ventana_inicio := v_reserva.slot_inicio - (v_ventana_min * 2 || ' minutes')::interval;
  v_ventana_fin := v_reserva.slot_fin + (v_ventana_min * 4 || ' minutes')::interval;

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'DEMASIADO_TEMPRANO: El check-in manual abre % min antes (a las %)',
      v_ventana_min * 2, to_char(v_ventana_inicio, 'HH24:MI');
  END IF;

  IF v_now > v_ventana_fin THEN
    RAISE EXCEPTION 'DEMASIADO_TARDE: El check-in manual cerró a las %',
      to_char(v_ventana_fin, 'HH24:MI');
  END IF;

  -- La reserva pudo nacer de un plan "por cobrar" que se canceló sin pagar
  -- (caso Betsaida, The Core 23-oct-2026): su crédito nunca existió. Antes de
  -- marcar presente se traslada al plan vigente del socio y se cobra ahí
  -- (SIN_CREDITOS_TRASLADO si no alcanza). Si no aplica, devuelve el motivo.
  v_traslado := _reserva_trasladar_a_plan_vigente(p_reserva_id, v_user_id);

  UPDATE reservas
  SET status = 'completada',
      check_in_at = v_now,
      check_in_by = v_user_id,
      check_in_method = 'manual',
      notas = COALESCE(notas, '') ||
              CASE WHEN p_motivo IS NOT NULL
                   THEN E'\n[Check-in manual: ' || p_motivo || ']'
                   ELSE E'\n[Check-in manual]'
              END
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;
  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;

  v_inicio_semana := date_trunc('week', v_now);

  SELECT count(*) INTO v_check_ins_hoy
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= date_trunc('day', v_now);

  SELECT count(*) INTO v_check_ins_semana
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= v_inicio_semana;

  IF v_rol IN ('recepcionista', 'admin') THEN
    PERFORM _audrec_log(
      'checkin.manual', 'reserva', p_reserva_id, v_reserva.usuario_id, v_miembro.nombre,
      format('Check-in manual de %s.%s',
             to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI'),
             CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
                  THEN ' Motivo: ' || p_motivo ELSE '' END),
      jsonb_build_object('method', 'manual', 'motivo', p_motivo, 'traslado', v_traslado)
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva', row_to_json(v_reserva),
    'miembro', jsonb_build_object(
      'id', v_miembro.id,
      'nombre', v_miembro.nombre,
      'email', v_miembro.email,
      'telefono', v_miembro.telefono,
      'avatar_url', v_miembro.avatar_url,
      'membresia_tier', v_miembro.membresia_tier,
      'notas_admin', v_miembro.notas_admin
    ),
    'recurso', jsonb_build_object(
      'id', v_recurso.id,
      'nombre', v_recurso.nombre
    ),
    'membresia_estado', _estado_membresia_checkin(v_reserva.usuario_id),
    'traslado', v_traslado,
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION check_in_manual_atomic(uuid, text) TO authenticated;

-- D.3 huella (service_role, agente)
CREATE OR REPLACE FUNCTION check_in_por_huella(
  p_token text,
  p_usuario_id uuid,
  p_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lector lectores_biometricos;
  v_socio usuarios;
  v_reserva reservas;
  v_recurso recursos;
  v_clase clases;
  v_ventana integer;
  v_traslado jsonb;
BEGIN
  SELECT * INTO v_lector
  FROM lectores_biometricos
  WHERE token_hash = _hash_token_lector(p_token);

  IF v_lector.id IS NULL THEN
    RAISE EXCEPTION 'LECTOR_DESCONOCIDO: Ese lector no está dado de alta';
  END IF;

  IF NOT v_lector.activo THEN
    RAISE EXCEPTION 'LECTOR_INACTIVO: Ese lector está desactivado';
  END IF;

  UPDATE lectores_biometricos SET ultimo_visto_at = now() WHERE id = v_lector.id;

  SELECT u.* INTO v_socio
  FROM usuarios u
  WHERE u.id = p_usuario_id
    AND u.tenant_id = v_lector.tenant_id
    AND EXISTS (
      SELECT 1 FROM credenciales_biometricas c
      WHERE c.usuario_id = u.id
        AND c.tenant_id = v_lector.tenant_id
        AND c.revocada_at IS NULL
    );

  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'HUELLA_NO_RECONOCIDA: Esa huella no está registrada en este gimnasio';
  END IF;

  v_ventana := ventana_check_in_min(v_lector.tenant_id);

  -- W2-03: FOR UPDATE OF r serializa el check-in de la reserva elegida; el segundo
  -- ingreso concurrente bloquea y luego ya no la encuentra 'confirmada'.
  SELECT r.* INTO v_reserva
  FROM reservas r
  JOIN recursos rec ON rec.id = r.recurso_id
  WHERE r.tenant_id = v_lector.tenant_id
    AND r.usuario_id = v_socio.id
    AND r.status = 'confirmada'
    AND p_at >= r.slot_inicio - (v_ventana || ' minutes')::interval
    AND p_at <= r.slot_fin + (v_ventana * 2 || ' minutes')::interval
    AND (
      v_lector.sucursal_id IS NULL
      OR rec.sucursal_id = v_lector.sucursal_id
    )
  ORDER BY abs(extract(epoch FROM (r.slot_inicio - p_at)))
  LIMIT 1
  FOR UPDATE OF r;

  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'SIN_RESERVA: % no tiene ninguna reserva para este momento',
      COALESCE(v_socio.nombre, v_socio.email);
  END IF;

  PERFORM _guard_membresia_checkin(v_socio.id);

  -- La reserva pudo nacer de un plan "por cobrar" que se canceló sin pagar
  -- (caso Betsaida, The Core 23-oct-2026): su crédito nunca existió. Antes de
  -- marcar presente se traslada al plan vigente del socio y se cobra ahí
  -- (SIN_CREDITOS_TRASLADO si no alcanza). Si no aplica, devuelve el motivo.
  v_traslado := _reserva_trasladar_a_plan_vigente(v_reserva.id, NULL);

  UPDATE reservas
  SET status = 'completada',
      check_in_at = p_at,
      check_in_by = NULL,
      check_in_method = 'huella'
  WHERE id = v_reserva.id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;
  SELECT * INTO v_clase   FROM clases   WHERE id = v_reserva.clase_id;

  -- HOTFIX: bitácora BEST-EFFORT (restaura 20260814180000). El agente entra por
  -- service_role SIN JWT → _audrec_log lanza NO_AUTORIZADO y, sin este bloque,
  -- revertía el check-in entero. El bloque solo revierte su propio savepoint:
  -- el UPDATE de reservas de arriba queda firme.
  BEGIN
    PERFORM _audrec_log(
      'checkin.huella', 'reserva', v_reserva.id, v_socio.id, v_socio.nombre,
      format('Entró con huella por el lector "%s".', v_lector.nombre),
      jsonb_build_object('lector_id', v_lector.id, 'lector', v_lector.nombre, 'traslado', v_traslado)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- la bitácora es secundaria; nunca revierte la entrada
  END;

  RETURN jsonb_build_object(
    'success', true,
    'socio', jsonb_build_object(
      'id', v_socio.id,
      'nombre', v_socio.nombre,
      'avatar_url', v_socio.avatar_url
    ),
    'reserva_id', v_reserva.id,
    'traslado', v_traslado,
    'clase', COALESCE(v_clase.nombre, v_recurso.nombre),
    'hora', to_char(v_reserva.slot_inicio, 'HH24:MI')
  );
END;
$$;

REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION check_in_por_huella(text, uuid, timestamptz) TO service_role;

-- D.4 marcar asistencia desde la agenda (incluye no_show → presente)
CREATE OR REPLACE FUNCTION public.admin_marcar_asistencia(p_reserva_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_reserva reservas;
  v_miembro usuarios;
  v_status_origen text;
  v_es_restauracion boolean;
  v_clase clases;
  v_recurso recursos;
  v_cupo_efectivo integer;
  v_cupos_ocupados integer;
  v_le_origen uuid;
  v_le_mem uuid;
  v_mem_id uuid;
  v_total_debitado integer := 0;
  v_total_devuelto integer := 0;
  v_monto_original integer := 0;
  v_neto_actual integer := 0;
  v_monto_redebitar integer := 0;
  v_mem_status text;
  v_mem_tier uuid;
  v_mem_creditos_actuales integer;
  v_tier_tipo text;
  v_nuevo_saldo integer;
  v_motivo_led text;
  v_traslado jsonb;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden corregir la asistencia';
  END IF;

  -- R: lock de la reserva (idéntico al original; sin JOIN -> sin anomalía EvalPlanQual).
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;
  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;
  IF v_reserva.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esta reserva pertenece a otro gimnasio';
  END IF;

  -- #9 aislamiento por sede (recepción solo opera su sede) — sin cambios.
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_reserva.clase_id));

  v_status_origen := v_reserva.status;

  IF v_status_origen = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este socio ya figura como presente';
  END IF;

  IF v_status_origen NOT IN ('confirmada', 'cancelada', 'cancelada_admin', 'no_show') THEN
    RAISE EXCEPTION 'RESERVA_ESTADO_INVALIDO: no se puede marcar asistencia desde el estado %', v_status_origen;
  END IF;

  IF v_reserva.slot_inicio > now() THEN
    RAISE EXCEPTION 'CLASE_NO_INICIADA: Esa clase todavía no empieza; no se puede marcar asistencia';
  END IF;

  -- Restauración = venía de un estado que YA NO ocupaba cupo. 'confirmada'
  -- SIEMPRE cuenta como ocupante en todo el resto del sistema -> jamás es
  -- restauración, y por lo tanto jamás toca X/M (check-in normal intacto).
  v_es_restauracion := v_status_origen IN ('cancelada', 'cancelada_admin', 'no_show');

  IF v_es_restauracion THEN
    -- X: mismo advisory lock de clase que reservar_clase_atomic /
    -- _cancelar_reserva_core (namespace 'clase_lugares:<clase_id>'). Se toma
    -- DESPUÉS de R, ANTES de M.
    IF v_reserva.clase_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext('clase_lugares:' || v_reserva.clase_id::text));

      SELECT * INTO v_clase FROM clases WHERE id = v_reserva.clase_id;
      SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;

      -- Pre-chequeo de asiento mapeado (mensaje claro); el índice único
      -- reservas_lugar_unico sigue siendo el backstop final a nivel DB.
      IF v_recurso.layout IS NOT NULL AND v_reserva.lugar_id IS NOT NULL THEN
        IF EXISTS (
          SELECT 1 FROM reservas
          WHERE clase_id = v_reserva.clase_id
            AND lugar_id = v_reserva.lugar_id
            AND status IN ('confirmada', 'completada')
            AND id <> p_reserva_id
        ) THEN
          RAISE EXCEPTION 'LUGAR_OCUPADO: el lugar % de esta clase ya fue tomado por otra reserva', v_reserva.lugar_id;
        END IF;
      END IF;

      SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
      FROM reservas
      WHERE clase_id = v_reserva.clase_id
        AND status IN ('confirmada', 'completada')
        AND id <> p_reserva_id;

      v_cupo_efectivo := CASE
        WHEN v_recurso.layout IS NOT NULL
          THEN COALESCE(jsonb_array_length(v_recurso.layout->'lugares'), v_clase.cupo_max)
        ELSE v_clase.cupo_max
      END;

      IF v_cupos_ocupados + 1 + COALESCE(v_reserva.invitados_count, 0) > v_cupo_efectivo THEN
        RAISE EXCEPTION 'CUPO_LLENO: Esta clase está llena (% / %); no se puede restaurar la asistencia', v_cupos_ocupados, v_cupo_efectivo;
      END IF;
    END IF;

    -- Procedencia económica inmutable: misma resolución que _cancelar_reserva_core.
    SELECT le.id, le.membresia_id INTO v_le_origen, v_le_mem
    FROM lista_espera le
    WHERE le.reserva_id = p_reserva_id AND le.status = 'promovido'
    LIMIT 1;

    v_mem_id := COALESCE(v_reserva.membresia_id, v_le_mem);
    IF v_mem_id IS NULL THEN
      SELECT mm.membresia_id INTO v_mem_id
      FROM membresia_movimientos mm
      WHERE mm.tipo = 'debito'
        AND (mm.reserva_id = p_reserva_id
             OR (v_le_origen IS NOT NULL AND mm.lista_espera_id = v_le_origen))
      ORDER BY mm.created_at, mm.id
      LIMIT 1;
    END IF;

    IF v_mem_id IS NOT NULL THEN
      SELECT
        COALESCE(SUM(-delta_creditos) FILTER (WHERE tipo = 'debito'), 0),
        COALESCE(SUM(delta_creditos)  FILTER (WHERE tipo = 'devolucion'), 0)
      INTO v_total_debitado, v_total_devuelto
      FROM membresia_movimientos
      WHERE membresia_id = v_mem_id
        AND (reserva_id = p_reserva_id
             OR (v_le_origen IS NOT NULL AND lista_espera_id = v_le_origen));

      -- Monto original = el PRIMER débito jamás registrado para esta reserva
      -- (evidencia persistida; nunca se recalcula desde 1+invitados actual).
      SELECT COALESCE(-delta_creditos, 0) INTO v_monto_original
      FROM membresia_movimientos
      WHERE membresia_id = v_mem_id
        AND tipo = 'debito'
        AND (reserva_id = p_reserva_id
             OR (v_le_origen IS NOT NULL AND lista_espera_id = v_le_origen))
      ORDER BY created_at, id
      LIMIT 1;

      v_neto_actual := v_total_debitado - v_total_devuelto;
      v_monto_redebitar := GREATEST(0, v_monto_original - v_neto_actual);
    END IF;

    IF v_monto_redebitar > 0 THEN
      -- M: lock de membresía ORIGINAL por su id, sin JOIN (mismo patrón
      -- anti-EvalPlanQual que _cancelar_reserva_core).
      SELECT m.status, m.tier_id, m.creditos_restantes
        INTO v_mem_status, v_mem_tier, v_mem_creditos_actuales
      FROM membresias m WHERE m.id = v_mem_id FOR UPDATE;

      SELECT t.tipo INTO v_tier_tipo FROM tiers t WHERE t.id = v_mem_tier;

      IF v_mem_status IS NULL
         OR v_mem_status NOT IN ('trialing', 'activa', 'past_due', 'congelada')
         OR v_tier_tipo IS NULL
         OR v_tier_tipo NOT IN ('creditos', 'hibrido') THEN
        RAISE EXCEPTION 'ENTITLEMENT_NO_RESTAURABLE: la membresía original ya no puede recibir este cargo (status=%, tier=%)',
          v_mem_status, v_tier_tipo;
      END IF;

      IF COALESCE(v_mem_creditos_actuales, 0) < v_monto_redebitar THEN
        RAISE EXCEPTION 'SIN_CREDITOS_RESTAURACION: Para restaurar esta asistencia hacen falta % crédito(s) y el socio tiene %',
          v_monto_redebitar, COALESCE(v_mem_creditos_actuales, 0);
      END IF;

      SELECT nombre INTO v_motivo_led FROM clases WHERE id = v_reserva.clase_id;
      v_motivo_led := 'restauración de asistencia tras cancelación (' || COALESCE(v_motivo_led, '') || ')'
        || CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0 THEN ' — ' || p_motivo ELSE '' END;

      -- Fail-closed en saldo insuficiente: _aplicar_credito ya veta saldo negativo
      -- (backstop; el pre-chequeo de arriba ya cubre el caso normal con un error
      -- más específico para la UX de recepción).
      v_nuevo_saldo := _aplicar_credito(
        v_mem_id, -v_monto_redebitar, 'debito', v_motivo_led,
        p_reserva_id, v_le_origen, v_actor
      );
    END IF;
  END IF;

  -- La reserva pudo nacer de un plan "por cobrar" que se canceló sin pagar
  -- (caso Betsaida, The Core 23-oct-2026): su crédito nunca existió. Después de
  -- la restauración (R → X → M respetado) y antes de marcar presente se traslada
  -- al plan vigente del socio y se cobra ahí (SIN_CREDITOS_TRASLADO si no
  -- alcanza). Si no aplica, devuelve el motivo.
  v_traslado := _reserva_trasladar_a_plan_vigente(p_reserva_id, v_actor);

  -- Transición final: guardada por el status de origen aunque R ya esté
  -- tomado (mismo estilo defensivo del resto del código base).
  UPDATE reservas
  SET status = 'completada',
      check_in_at = now(),
      check_in_by = v_actor,
      check_in_method = 'manual',
      updated_at = now()
  WHERE id = p_reserva_id AND status = v_status_origen
  RETURNING * INTO v_reserva;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESERVA_CONCURRENTEMENTE_MODIFICADA: el estado de la reserva cambió durante la operación';
  END IF;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;

  PERFORM _audrec_log(
    'clase.marcar_asistencia', 'reserva', p_reserva_id, v_reserva.usuario_id, v_miembro.nombre,
    format('Corrigió la asistencia a "presente" en la clase de %s.%s',
           to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI'),
           CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
                THEN ' Motivo: ' || p_motivo ELSE '' END),
    jsonb_build_object(
      'motivo', p_motivo,
      'status_origen', v_status_origen,
      'restauracion', v_es_restauracion,
      'creditos_redebitados', v_monto_redebitar,
      'traslado', v_traslado
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', p_reserva_id,
    'status_origen', v_status_origen,
    'restauracion', v_es_restauracion,
    'creditos_redebitados', v_monto_redebitar,
    'traslado', v_traslado
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_marcar_asistencia(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_marcar_asistencia(uuid, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- SELF-TEST ESTRUCTURAL — DEVUELVE TABLA. Verifica que cada función quedó con
-- lo que debe (y sin lo que no debe, contrato W3 del check-in manual). La
-- prueba funcional (con datos, en BEGIN/ROLLBACK) está en
-- scripts/test_reserva_sigue_plan_vigente.sql.
-- ════════════════════════════════════════════════════════════════════════════
-- (sin ON COMMIT DROP: bajo psql -f cada sentencia es su propia transacción)
DROP TABLE IF EXISTS _rspv;
CREATE TEMP TABLE _rspv (orden int, prueba text, ok boolean);
DO $t$
DECLARE
  v_src text;
BEGIN
  v_src := pg_get_functiondef('check_in_atomic(uuid)'::regprocedure);
  INSERT INTO _rspv VALUES (1, 'QR llama al traslado y conserva guards W3',
    position('_reserva_trasladar_a_plan_vigente' IN v_src) > 0
    AND position('_guard_membresia_checkin' IN v_src) > 0
    AND position('_guard_sucursal_staff' IN v_src) > 0
    AND position('FOR UPDATE' IN v_src) > 0);

  v_src := pg_get_functiondef('check_in_manual_atomic(uuid, text)'::regprocedure);
  INSERT INTO _rspv VALUES (2, 'manual llama al traslado, NO bloquea por membresía (W3)',
    position('_reserva_trasladar_a_plan_vigente' IN v_src) > 0
    AND position('_guard_membresia_checkin' IN v_src) = 0
    AND position('_guard_pago_pendiente_checkin' IN v_src) > 0
    AND position('FOR UPDATE' IN v_src) > 0);

  v_src := pg_get_functiondef('check_in_por_huella(text, uuid, timestamptz)'::regprocedure);
  INSERT INTO _rspv VALUES (3, 'huella llama al traslado y conserva guard de membresía',
    position('_reserva_trasladar_a_plan_vigente' IN v_src) > 0
    AND position('_guard_membresia_checkin' IN v_src) > 0);

  v_src := pg_get_functiondef('admin_marcar_asistencia(uuid, text)'::regprocedure);
  INSERT INTO _rspv VALUES (4, 'marcar asistencia llama al traslado después de la restauración',
    position('_reserva_trasladar_a_plan_vigente' IN v_src) > 0
    AND position('_reserva_trasladar_a_plan_vigente' IN v_src) > position('ENTITLEMENT_NO_RESTAURABLE' IN v_src));

  v_src := pg_get_functiondef('gestionar_membresia_socio(uuid, uuid, text, text, integer, boolean, uuid)'::regprocedure);
  INSERT INTO _rspv VALUES (5, 'gestionar_membresia_socio tiene el candado PLAN_POR_COBRAR_PENDIENTE',
    position('PLAN_POR_COBRAR_PENDIENTE' IN v_src) > 0);

  v_src := pg_get_functiondef('_cancelar_plan_por_cobrar(uuid, text)'::regprocedure);
  INSERT INTO _rspv VALUES (6, '_cancelar_plan_por_cobrar libera futuras debitadas y reporta conteos',
    position('reservas_liberadas' IN v_src) > 0 AND position('reservas_en_curso' IN v_src) > 0);

  INSERT INTO _rspv VALUES (7, 'helper sin EXECUTE para authenticated/anon',
    NOT has_function_privilege('authenticated', '_reserva_trasladar_a_plan_vigente(uuid, uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', '_reserva_trasladar_a_plan_vigente(uuid, uuid)', 'EXECUTE'));

  INSERT INTO _rspv VALUES (8, 'check-ins conservan EXECUTE para authenticated (QR/manual/asistencia) y huella solo service_role',
    has_function_privilege('authenticated', 'check_in_atomic(uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'check_in_manual_atomic(uuid, text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'admin_marcar_asistencia(uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'check_in_por_huella(text, uuid, timestamptz)', 'EXECUTE'));
END $t$;

SELECT orden, prueba, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS resultado
FROM _rspv ORDER BY orden;
