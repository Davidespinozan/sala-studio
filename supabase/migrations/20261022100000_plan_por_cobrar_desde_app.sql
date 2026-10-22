-- ============================================================================
-- ELEGIR PLAN EN LA APP Y PAGAR EN RECEPCIÓN: RESERVA YA, ENTRA CUANDO PAGUE
-- ----------------------------------------------------------------------------
-- Pedido de The Core (22-oct-2026): cero fricción para entrar y elegir plan. La
-- socia elige su paquete en la app y decide tarjeta (Stripe) o recepción. Con
-- "Pagar en recepción" el plan queda ACTIVO de una vez con un cargo "por cobrar"
-- (el mismo mecanismo que usa recepción con "pagar al llegar"), así que puede
-- reservar de inmediato. Lo que la detiene es la ENTRADA: el check-in (manual,
-- QR y huella) se bloquea con PAGO_PENDIENTE hasta que recepción cobre el cargo.
--
-- Piezas:
--   1) _autoservicio_plan_on(): bandera local a la transacción que deja pasar a
--      gestionar_membresia_socio y registrar_cargo_pendiente cuando las llama el
--      wrapper de autoservicio (patrón de sala.cierre_tenant). Fuera de ese
--      wrapper nadie puede ponerla (set_config no está expuesto por PostgREST).
--   2) gestionar_membresia_socio y registrar_cargo_pendiente: cuerpo VIGENTE
--      (20261011100000 / 20260928120000) con esa única línea cambiada.
--   3) socio_activar_plan_por_cobrar(p_tier_id): el wrapper. Solo si el gym lo
--      permite (config.cobros.por_cobrar_autoservicio = true).
--   4) socio_cargos_pendientes(): la socia ve su propio cargo (la tabla solo la
--      lee recepción por RLS).
--   5) _guard_pago_pendiente_checkin + _guard_membresia_checkin (QR/huella) y
--      check_in_manual_atomic (manual, cuerpo vigente de 20260928140000):
--      bloqueo duro PAGO_PENDIENTE.
-- ============================================================================

-- ── 1) Bandera de autoservicio ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _autoservicio_plan_on()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('sala.autoservicio_plan', true), '') = 'on';
$$;
REVOKE ALL ON FUNCTION _autoservicio_plan_on() FROM PUBLIC, anon, authenticated;

-- ── 2a) gestionar_membresia_socio (vigente + bandera) ───────────────────────
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


-- ── 2b) registrar_cargo_pendiente (vigente + bandera) ───────────────────────
CREATE OR REPLACE FUNCTION registrar_cargo_pendiente(
  p_usuario_id uuid,
  p_monto_centavos integer,
  p_concepto text DEFAULT 'plan',
  p_descripcion text DEFAULT NULL,
  p_operation_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_socio usuarios;
  v_id uuid;
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  IF NOT (is_recepcionista() OR _autoservicio_plan_on()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden registrar un cargo';
  END IF;
  IF p_monto_centavos IS NULL OR p_monto_centavos <= 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO: El monto por cobrar debe ser mayor a 0';
  END IF;

  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'cargo', get_my_user_id(),
      md5(jsonb_build_object('usuario', p_usuario_id, 'monto', p_monto_centavos,
                             'concepto', p_concepto, 'desc', p_descripcion)::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL OR v_socio.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'SOCIO_NO_EXISTE: Ese socio no es de este gimnasio';
  END IF;

  INSERT INTO cargos_pendientes (
    tenant_id, sucursal_id, usuario_id, concepto, descripcion, monto_centavos, moneda, created_by
  ) VALUES (
    v_tenant, v_socio.sucursal_id, p_usuario_id,
    COALESCE(NULLIF(p_concepto, ''), 'plan'), p_descripcion, p_monto_centavos, 'MXN', get_my_user_id()
  )
  RETURNING id INTO v_id;

  v_result := jsonb_build_object('success', true, 'cargo_id', v_id, 'monto_centavos', p_monto_centavos);
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$$;


-- ── 3) Wrapper de autoservicio: activar plan dejándolo por cobrar ───────────
CREATE OR REPLACE FUNCTION socio_activar_plan_por_cobrar(p_tier_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   uuid;
  v_tenant  uuid;
  v_config  jsonb;
  v_tier    tiers%ROWTYPE;
  v_precio  jsonb;
  v_monto   integer;
  v_res     jsonb;
  v_cargo   jsonb;
  v_inscr   integer := 0;
BEGIN
  v_actor := get_my_user_id();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: usuario no autenticado';
  END IF;
  SELECT tenant_id INTO v_tenant FROM usuarios WHERE id = v_actor AND rol = 'miembro';
  IF v_tenant IS NULL OR v_tenant <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo un socio puede activar su plan';
  END IF;

  SELECT config INTO v_config FROM tenants WHERE id = v_tenant;
  IF COALESCE((v_config->'cobros'->>'por_cobrar_autoservicio')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'NO_DISPONIBLE: este gimnasio no activa planes por cobrar desde la app';
  END IF;

  SELECT * INTO v_tier FROM tiers WHERE id = p_tier_id AND tenant_id = v_tenant;
  IF v_tier.id IS NULL OR v_tier.activo IS DISTINCT FROM true OR v_tier.en_venta IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PLAN_NO_DISPONIBLE: ese plan no está a la venta';
  END IF;
  IF COALESCE(v_tier.precio_centavos, 0) <= 0 THEN
    RAISE EXCEPTION 'PLAN_GRATIS: un plan sin costo se activa directo, no por cobrar';
  END IF;

  IF EXISTS (
    SELECT 1 FROM membresias
    WHERE usuario_id = v_actor
      AND status IN ('activa', 'trialing', 'past_due', 'congelada')
      AND (periodo_actual_fin IS NULL OR periodo_actual_fin > now())
  ) THEN
    RAISE EXCEPTION 'YA_TIENE_PLAN: ya tienes una membresía vigente';
  END IF;
  IF EXISTS (SELECT 1 FROM cargos_pendientes WHERE usuario_id = v_actor AND estado = 'pendiente') THEN
    RAISE EXCEPTION 'CARGO_PENDIENTE_EXISTE: ya tienes un pago pendiente; págalo en recepción';
  END IF;
  IF v_tier.es_prueba IS TRUE AND EXISTS (SELECT 1 FROM pruebas_usadas WHERE usuario_id = v_actor) THEN
    RAISE EXCEPTION 'PRUEBA_YA_USADA: ya usaste tu clase de prueba';
  END IF;

  -- Precio con el descuento del socio (estudiante…), canal recepción: el mismo
  -- que cobraría el mostrador.
  v_precio := _precio_plan_para_socio(v_actor, p_tier_id, 'recepcion');
  v_monto := COALESCE((v_precio->>'precio_final_centavos')::integer, v_tier.precio_centavos);

  PERFORM set_config('sala.autoservicio_plan', 'on', true);
  -- Sin método de pago: NO registra pago. Activa la membresía (y la cuenta si
  -- estaba pendiente_pago), igual que recepción con "dejar pendiente".
  SELECT gestionar_membresia_socio(v_actor, p_tier_id, 'Plan elegido en la app; pago en recepción', NULL, NULL)
  INTO v_res;
  v_inscr := COALESCE((v_res->>'inscripcion_centavos')::integer, 0);
  SELECT registrar_cargo_pendiente(
    v_actor, v_monto + v_inscr, 'plan',
    format('Plan %s elegido en la app · pago en recepción', v_tier.nombre)
  ) INTO v_cargo;
  PERFORM set_config('sala.autoservicio_plan', 'off', true);

  RETURN jsonb_build_object(
    'tier_id', v_tier.id,
    'tier_nombre', v_tier.nombre,
    'monto_centavos', v_monto + v_inscr,
    'inscripcion_centavos', v_inscr,
    'cargo_id', v_cargo->>'cargo_id',
    'periodo_actual_fin', v_res->>'periodo_actual_fin',
    'creditos_restantes', v_res->'creditos_restantes'
  );
END;
$$;
REVOKE ALL ON FUNCTION socio_activar_plan_por_cobrar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION socio_activar_plan_por_cobrar(uuid) TO authenticated;

-- ── 4) La socia ve su propio pago pendiente ─────────────────────────────────
CREATE OR REPLACE FUNCTION socio_cargos_pendientes()
RETURNS TABLE (id uuid, monto_centavos integer, concepto text, descripcion text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.monto_centavos, c.concepto, c.descripcion, c.created_at
  FROM cargos_pendientes c
  WHERE c.usuario_id = get_my_user_id()
    AND c.estado = 'pendiente'
  ORDER BY c.created_at DESC;
$$;
REVOKE ALL ON FUNCTION socio_cargos_pendientes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION socio_cargos_pendientes() TO authenticated;

-- ── 5) Bloqueo duro en el check-in ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION _guard_pago_pendiente_checkin(p_usuario_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_monto integer;
BEGIN
  SELECT SUM(monto_centavos) INTO v_monto
  FROM cargos_pendientes WHERE usuario_id = p_usuario_id AND estado = 'pendiente';
  IF COALESCE(v_monto, 0) > 0 THEN
    RAISE EXCEPTION 'PAGO_PENDIENTE: El socio debe $% ; cóbralo antes del check-in', (v_monto / 100.0)::numeric(12,2);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION _guard_pago_pendiente_checkin(uuid) FROM PUBLIC, anon, authenticated;

-- Guard de QR/huella (cuerpo vigente de 20260819170000 + pago pendiente).
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
  IF v_estado = 'sin_membresia' THEN
    RAISE EXCEPTION 'SIN_MEMBRESIA: El socio no tiene una membresía activa';
  ELSIF v_estado = 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_CONGELADA: La membresía del socio está pausada';
  ELSIF v_estado = 'vencida' THEN
    RAISE EXCEPTION 'MEMBRESIA_VENCIDA: La membresía del socio venció; ya no puede entrar';
  END IF;
  -- Plan activo pero sin pagar (por cobrar): no entra hasta que recepción cobre.
  PERFORM _guard_pago_pendiente_checkin(p_usuario_id);
END;
$$;

-- Check-in manual (cuerpo vigente de 20260928140000 + bloqueo por pago pendiente).
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
  -- check-in / Por cobrar). Mismo criterio que QR y huella (_guard_membresia_checkin).
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
      jsonb_build_object('method', 'manual', 'motivo', p_motivo)
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
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;


-- ── Verificación (devuelve tabla) ───────────────────────────────────────────
SELECT p.proname AS funcion,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_puede,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_puede,
       (pg_get_functiondef(p.oid) LIKE '%_autoservicio_plan_on()%' OR pg_get_functiondef(p.oid) LIKE '%PAGO_PENDIENTE%' OR pg_get_functiondef(p.oid) LIKE '%_guard_pago_pendiente_checkin%') AS con_cambio
FROM pg_proc p
WHERE p.proname IN ('socio_activar_plan_por_cobrar','socio_cargos_pendientes','gestionar_membresia_socio',
                    'registrar_cargo_pendiente','_guard_membresia_checkin','check_in_manual_atomic',
                    '_guard_pago_pendiente_checkin','_autoservicio_plan_on')
ORDER BY p.proname;
