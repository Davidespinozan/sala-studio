-- ════════════════════════════════════════════════════════════════════════════
-- #9 — Aislamiento por SEDE en las RPCs de recepción (branch isolation hardening)
-- ════════════════════════════════════════════════════════════════════════════
-- Problema: ~24 RPCs SECURITY DEFINER alcanzables por recepción validaban el
-- TENANT pero no la SEDE. Una recepcionista fija a la sede A podía cobrar,
-- reembolsar, cambiar planes, cancelar reservas/clases, vender o hacer corte de
-- caja sobre recursos de la sede B del mismo gimnasio.
--
-- Política (aprobada por el owner):
--   · Solo aplica a rol 'recepcionista'. admin / miembro pasan sin cambios.
--   · Recepcionista sin sede asignada        → SUCURSAL_ACTOR_NO_ASIGNADA (fail-closed).
--   · Recurso sin sede canónica (NULL)       → SUCURSAL_RECURSO_DESCONOCIDA (fail-closed).
--   · Recurso de otra sede                   → SUCURSAL_DIFERENTE.
--   · RPCs que reciben p_sucursal_id (POS/caja): recepción solo puede pasar SU
--     sede; NULL ("todas las sedes") o una sede ajena → SUCURSAL_PARAMETRO_INVALIDO.
--
-- Dos helpers NUEVOS e independientes. NO se toca _guard_sucursal_staff ni sus
-- dos callers (check_in_atomic / check_in_manual_atomic), ni RLS, ni
-- _liberar_reservas_membresia, ni los wrappers delgados (recepcion_asignar_plan /
-- cambiar_plan / renovar_membresia, recepcion_crear_reserva_con_multa,
-- recepcion_cancelar_reserva, recepcion_reservar_pase_dia): heredan el guard del
-- motor que llaman.
--
-- Corrección al diseño (ver reporte §P): el rol y la sede del actor se leen de
-- la MISMA ficha activa (get_my_user_id(), que respeta x-tenant-id), no de
-- get_my_rol() (que hace `auth_id = auth.uid() LIMIT 1` sin tenant y puede
-- devolver la ficha de OTRO gimnasio para cuentas multi-gym). Así el guard es
-- coherente con is_recepcionista()/get_my_tenant_id(). Semántica de NULL sin
-- cambios respecto al diseño: sin ficha activa (rol NULL) → no hay early-return
-- → SUCURSAL_ACTOR_NO_ASIGNADA (fail-closed; ningún caller service_role llega).
--
-- Cada función parcheada es el cuerpo VIGENTE (pg_get_functiondef tras aplicar
-- todas las migraciones previas) + SOLO la línea del guard (y, donde hacía
-- falta, la columna sucursal_id/clase_id agregada al SELECT ya existente, sin
-- locks nuevos). CREATE OR REPLACE conserva owner y GRANTs existentes.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Helpers ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _guard_sucursal_recepcion(p_resource_sucursal uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor_rol text;
  v_actor_suc uuid;
BEGIN
  SELECT rol, sucursal_id INTO v_actor_rol, v_actor_suc
  FROM usuarios WHERE id = get_my_user_id();
  IF v_actor_rol <> 'recepcionista' THEN
    RETURN; -- admin, miembro, staff (diferido) pasan sin cambios
  END IF;
  IF v_actor_suc IS NULL THEN
    RAISE EXCEPTION 'SUCURSAL_ACTOR_NO_ASIGNADA: recepcionista sin sucursal asignada';
  END IF;
  IF p_resource_sucursal IS NULL THEN
    RAISE EXCEPTION 'SUCURSAL_RECURSO_DESCONOCIDA: recurso sin sucursal asignada';
  END IF;
  IF v_actor_suc <> p_resource_sucursal THEN
    RAISE EXCEPTION 'SUCURSAL_DIFERENTE: recurso pertenece a otra sede';
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION _guard_sucursal_recepcion_param(p_sucursal_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor_rol text;
  v_actor_suc uuid;
BEGIN
  SELECT rol, sucursal_id INTO v_actor_rol, v_actor_suc
  FROM usuarios WHERE id = get_my_user_id();
  IF v_actor_rol <> 'recepcionista' THEN RETURN; END IF;
  IF v_actor_suc IS NULL THEN
    RAISE EXCEPTION 'SUCURSAL_ACTOR_NO_ASIGNADA: recepcionista sin sucursal asignada';
  END IF;
  IF p_sucursal_id IS NULL OR p_sucursal_id <> v_actor_suc THEN
    RAISE EXCEPTION 'SUCURSAL_PARAMETRO_INVALIDO: recepcion solo puede operar su propia sede';
  END IF;
END; $$;

-- Mismo esquema de privilegios que _guard_sucursal_staff: solo authenticated.
REVOKE ALL ON FUNCTION _guard_sucursal_recepcion(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION _guard_sucursal_recepcion(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION _guard_sucursal_recepcion(uuid) TO authenticated;
REVOKE ALL ON FUNCTION _guard_sucursal_recepcion_param(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION _guard_sucursal_recepcion_param(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION _guard_sucursal_recepcion_param(uuid) TO authenticated;

-- ── RPCs parcheadas (cuerpo vigente + guard) ────────────────────────────────
-- Fuente canónica de sede por familia:
--   cargos → cargos_pendientes.sucursal_id · pagos → pagos.sucursal_id (inmutable)
--   inscripción → usuarios.sucursal_id del socio · créditos/estado de membresía →
--   membresias.sucursal_id (la fila ya bloqueada/leída) · motor de planes →
--   membresía anterior si existe, si no la sede del socio · reservas/multa →
--   reservas.clase_id → clases.sucursal_id · clases → clases.sucursal_id ·
--   entregas → tienda_entregas.sucursal_id · POS/caja → p_sucursal_id.

-- ── cobrar_cargo_pendiente ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cobrar_cargo_pendiente(p_cargo_id uuid, p_metodo text DEFAULT 'efectivo'::text, p_operation_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cargo cargos_pendientes;
  v_pago_id uuid;
  v_tenant uuid := get_my_tenant_id();
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden cobrar';
  END IF;
  IF p_metodo NOT IN ('efectivo','tarjeta','transferencia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: Método de pago no válido';
  END IF;

  -- Idempotencia ANTES del guard de estado: un reintento con la misma key devuelve
  -- el pago original (already_processed) en vez del confuso CARGO_NO_PENDIENTE.
  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'cobro_cargo', get_my_user_id(),
      md5(jsonb_build_object('cargo', p_cargo_id, 'metodo', p_metodo)::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  -- P1 fix: FOR UPDATE serializa a nivel de fila sobre ESTE cargo_id. Un segundo
  -- cobrador concurrente espera aquí, y al despertar ve el estado ya comiteado.
  SELECT * INTO v_cargo FROM cargos_pendientes WHERE id = p_cargo_id FOR UPDATE;
  IF v_cargo.id IS NULL OR v_cargo.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'CARGO_NO_EXISTE: Ese cargo no es de este gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_cargo.sucursal_id);
  IF v_cargo.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'CARGO_NO_PENDIENTE: Ese cargo ya está % (no se puede cobrar de nuevo)', v_cargo.estado;
  END IF;

  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id, concepto, monto_centavos, moneda, metodo, referencia, notas, cobrado_por
  ) VALUES (
    v_cargo.tenant_id, v_cargo.sucursal_id, v_cargo.usuario_id, v_cargo.concepto,
    v_cargo.monto_centavos, v_cargo.moneda, p_metodo, NULL,
    'Cobro de pendiente' || COALESCE(' · ' || v_cargo.descripcion, ''), get_my_user_id()
  )
  RETURNING id INTO v_pago_id;

  UPDATE cargos_pendientes
  SET estado = 'cobrado', pago_id = v_pago_id, cobrado_at = now()
  WHERE id = p_cargo_id;

  v_result := jsonb_build_object('success', true, 'pago_id', v_pago_id, 'monto_centavos', v_cargo.monto_centavos);
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$function$;

-- ── cancelar_cargo_pendiente ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancelar_cargo_pendiente(p_cargo_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cargo cargos_pendientes;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden cancelar';
  END IF;
  SELECT * INTO v_cargo FROM cargos_pendientes WHERE id = p_cargo_id;
  IF v_cargo.id IS NULL OR v_cargo.tenant_id <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'CARGO_NO_EXISTE: Ese cargo no es de este gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_cargo.sucursal_id);
  IF v_cargo.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'CARGO_NO_PENDIENTE: Ese cargo ya está %', v_cargo.estado;
  END IF;

  UPDATE cargos_pendientes
  SET estado = 'cancelado', motivo_cancelacion = NULLIF(trim(p_motivo), '')
  WHERE id = p_cargo_id;

  RETURN jsonb_build_object('success', true);
END;
$function$;

-- ── cobrar_inscripcion_socio ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cobrar_inscripcion_socio(p_usuario_id uuid, p_metodo text, p_monto_centavos integer DEFAULT NULL::integer, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid;
  v_socio usuarios;
  v_mem_id uuid;
  v_tier_id uuid;
  v_sucursal uuid;
  v_monto integer;
  v_moneda text;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo staff (admin/recepción) puede cobrar inscripción';
  END IF;
  IF p_metodo NOT IN ('efectivo', 'tarjeta', 'transferencia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: usa efectivo, tarjeta o transferencia';
  END IF;

  v_tenant := get_my_tenant_id();

  SELECT * INTO v_socio FROM usuarios
  WHERE id = p_usuario_id AND tenant_id = v_tenant AND rol = 'miembro';
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE: el socio no existe en tu gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_socio.sucursal_id);
  IF v_socio.inscripcion_pagada_at IS NOT NULL THEN
    RAISE EXCEPTION 'INSCRIPCION_YA_PAGADA: este socio ya tiene la inscripción registrada';
  END IF;

  -- Membresía más reciente: de ahí salen tier, sede, monto y moneda (o se pasa monto).
  SELECT m.id, m.tier_id, m.sucursal_id,
         COALESCE(p_monto_centavos, t.inscripcion_centavos, 0),
         COALESCE(t.moneda, 'MXN')
  INTO v_mem_id, v_tier_id, v_sucursal, v_monto, v_moneda
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id AND m.tenant_id = v_tenant
  ORDER BY m.created_at DESC
  LIMIT 1;

  -- Sin membresía → usa el monto explícito (si lo dan).
  IF v_mem_id IS NULL THEN
    v_monto := COALESCE(p_monto_centavos, 0);
    v_moneda := 'MXN';
  END IF;

  IF COALESCE(v_monto, 0) <= 0 THEN
    RAISE EXCEPTION 'SIN_MONTO: el plan no tiene inscripción configurada; indica el monto a cobrar';
  END IF;

  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
    concepto, monto_centavos, moneda, metodo, notas, cobrado_por
  ) VALUES (
    v_tenant, v_sucursal, p_usuario_id, v_mem_id, v_tier_id,
    'inscripcion', v_monto, v_moneda, p_metodo,
    COALESCE(NULLIF(trim(p_motivo), ''), 'inscripción (cobro manual)'), get_my_user_id()
  );

  UPDATE usuarios SET inscripcion_pagada_at = now() WHERE id = p_usuario_id;

  RETURN jsonb_build_object('ok', true, 'monto_centavos', v_monto, 'moneda', v_moneda);
END;
$function$;

-- ── cobrar_multa_reserva ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cobrar_multa_reserva(p_reserva_id uuid, p_metodo text DEFAULT 'efectivo'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reserva reservas;
  v_sucursal uuid;
  v_pago_id uuid;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden cobrar multas';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;
  IF v_reserva.id IS NULL OR v_reserva.tenant_id <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: Esa reserva no es de este gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_reserva.clase_id));

  IF COALESCE(v_reserva.multa_centavos, 0) <= 0 THEN
    RAISE EXCEPTION 'SIN_MULTA: Esta reserva no tiene multa que cobrar';
  END IF;

  IF v_reserva.multa_pagada THEN
    RAISE EXCEPTION 'MULTA_YA_PAGADA: Esta multa ya se cobró';
  END IF;

  IF p_metodo NOT IN ('efectivo', 'tarjeta', 'transferencia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: Método de pago no válido';
  END IF;

  -- La sucursal del pago = la de la sala de la reserva (reservas no la guarda directo).
  SELECT sucursal_id INTO v_sucursal FROM recursos WHERE id = v_reserva.recurso_id;

  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id,
    concepto, monto_centavos, moneda, metodo, referencia, notas, cobrado_por
  ) VALUES (
    v_reserva.tenant_id, v_sucursal, v_reserva.usuario_id,
    'otro', v_reserva.multa_centavos, 'MXN', p_metodo,
    v_reserva.folio,
    'Multa por reservar tras faltar (' || v_reserva.folio || ')',
    get_my_user_id()
  )
  RETURNING id INTO v_pago_id;

  UPDATE reservas
  SET multa_pagada = true, multa_pago_id = v_pago_id
  WHERE id = p_reserva_id;

  RETURN jsonb_build_object(
    'success', true,
    'pago_id', v_pago_id,
    'monto_centavos', v_reserva.multa_centavos
  );
END; $function$;

-- ── corregir_metodo_pago ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.corregir_metodo_pago(p_pago_id uuid, p_metodo text, p_motivo text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid;
  v_old text;
  v_pago_sucursal uuid;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo staff (admin/recepción) puede corregir el método de un pago';
  END IF;

  IF p_metodo NOT IN ('efectivo', 'tarjeta', 'transferencia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: método no válido (%); usa efectivo, tarjeta o transferencia', p_metodo;
  END IF;

  v_tenant := get_my_tenant_id();

  SELECT metodo, sucursal_id INTO v_old, v_pago_sucursal FROM pagos WHERE id = p_pago_id AND tenant_id = v_tenant;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'PAGO_NO_EXISTE: ese pago no existe en tu gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_pago_sucursal);

  -- Solo se reclasifica entre métodos de dinero de mostrador.
  IF v_old NOT IN ('efectivo', 'tarjeta', 'transferencia') THEN
    RAISE EXCEPTION 'METODO_NO_CORREGIBLE: este pago es % y no se reclasifica a mano', v_old;
  END IF;

  IF v_old = p_metodo THEN
    RETURN;  -- ya está en ese método
  END IF;

  PERFORM set_config('sala.corrige_metodo', 'on', true);

  UPDATE pagos
  SET metodo = p_metodo,
      notas = CASE WHEN COALESCE(trim(notas), '') = '' THEN '' ELSE trim(notas) || ' · ' END
              || format('[método corregido %s→%s%s]', v_old, p_metodo,
                        CASE WHEN NULLIF(trim(p_motivo), '') IS NOT NULL
                             THEN ': ' || trim(p_motivo) ELSE '' END)
  WHERE id = p_pago_id AND tenant_id = v_tenant;

  PERFORM set_config('sala.corrige_metodo', 'off', true);
END;
$function$;

-- ── registrar_reembolso ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.registrar_reembolso(p_pago_id uuid, p_monto_centavos integer DEFAULT NULL::integer, p_motivo text DEFAULT NULL::text, p_operation_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_pago pagos;
  v_socio usuarios;
  v_disponible integer;
  v_monto integer;
  v_reembolso_id uuid;
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden devolver dinero';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: Un reembolso sin motivo no se puede auditar después';
  END IF;

  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'reembolso', v_actor,
      md5(jsonb_build_object('pago', p_pago_id, 'monto', p_monto_centavos, 'motivo', trim(p_motivo))::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  SELECT * INTO v_pago FROM pagos WHERE id = p_pago_id;
  IF v_pago.id IS NULL THEN
    RAISE EXCEPTION 'PAGO_NO_EXISTE: No encontramos ese cobro';
  END IF;
  IF v_pago.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Ese cobro es de otro gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_pago.sucursal_id);
  IF v_pago.concepto = 'reembolso' THEN
    RAISE EXCEPTION 'NO_REEMBOLSABLE: Eso ya es un reembolso, no un cobro';
  END IF;
  IF v_pago.metodo = 'cortesia' THEN
    RAISE EXCEPTION 'NO_REEMBOLSABLE: Una cortesía no cobró nada';
  END IF;

  v_disponible := pago_reembolsable(p_pago_id);
  IF v_disponible <= 0 THEN
    RAISE EXCEPTION 'YA_REEMBOLSADO: Ese cobro ya se devolvió por completo';
  END IF;

  v_monto := COALESCE(p_monto_centavos, v_disponible);
  IF v_monto <= 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO: El monto a devolver tiene que ser mayor a cero';
  END IF;
  IF v_monto > v_disponible THEN
    RAISE EXCEPTION 'MONTO_EXCEDE: De ese cobro quedan % por devolver, no %',
      (v_disponible / 100.0)::numeric(12,2), (v_monto / 100.0)::numeric(12,2);
  END IF;

  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
    concepto, monto_centavos, moneda, metodo,
    referencia, notas, cobrado_por, revierte_pago_id
  ) VALUES (
    v_tenant, v_pago.sucursal_id, v_pago.usuario_id, v_pago.membresia_id, v_pago.tier_id,
    'reembolso', -v_monto, v_pago.moneda, v_pago.metodo,
    NULL, trim(p_motivo), v_actor, p_pago_id
  )
  RETURNING id INTO v_reembolso_id;

  SELECT * INTO v_socio FROM usuarios WHERE id = v_pago.usuario_id;

  PERFORM _audrec_log(
    'pago.reembolso', 'pago', v_reembolso_id, v_pago.usuario_id, v_socio.nombre,
    format('Devolvió %s (%s) del cobro de %s. Motivo: %s',
           to_char(v_monto / 100.0, 'FM999G999G990D00'),
           v_pago.metodo,
           to_char(v_pago.created_at, 'DD/MM/YYYY'),
           trim(p_motivo)),
    jsonb_build_object(
      'pago_original_id', p_pago_id,
      'monto_centavos', v_monto,
      'metodo', v_pago.metodo,
      'moneda', v_pago.moneda
    )
  );

  v_result := jsonb_build_object(
    'success', true,
    'reembolso_id', v_reembolso_id,
    'monto_centavos', v_monto,
    'moneda', v_pago.moneda,
    'metodo', v_pago.metodo,
    'pendiente_centavos', v_disponible - v_monto,
    'requiere_accion_en_stripe', v_pago.metodo = 'stripe'
  );
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$function$;

-- ── reembolsar_como_cortesia ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reembolsar_como_cortesia(p_pago_id uuid, p_monto_centavos integer DEFAULT NULL::integer, p_motivo text DEFAULT NULL::text, p_operation_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pago pagos;
  v_res jsonb;
  v_monto integer;
  v_cortesia_id uuid;
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden hacer esto';
  END IF;

  SELECT * INTO v_pago FROM pagos WHERE id = p_pago_id;
  IF v_pago.id IS NULL THEN
    RAISE EXCEPTION 'PAGO_NO_EXISTE: no encontramos ese cobro';
  END IF;
  IF v_pago.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese cobro no es de tu gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_pago.sucursal_id);

  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'reembolso_cortesia', v_actor,
      md5(jsonb_build_object('pago', p_pago_id, 'monto', p_monto_centavos, 'motivo', trim(p_motivo))::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  -- Anidado SIN key: registrar_reembolso no re-registra.
  v_res := registrar_reembolso(p_pago_id, p_monto_centavos, COALESCE(NULLIF(trim(p_motivo), ''), 'Fue cortesía'));
  v_monto := (v_res->>'monto_centavos')::integer;

  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id,
    concepto, monto_centavos, moneda, metodo, notas, cobrado_por
  ) VALUES (
    v_pago.tenant_id, v_pago.sucursal_id, v_pago.usuario_id,
    v_pago.concepto, v_monto, COALESCE(v_pago.moneda, 'MXN'), 'cortesia',
    'Cortesía (cobro revertido): ' || COALESCE(NULLIF(trim(p_motivo), ''), 'era cortesía'),
    v_actor
  )
  RETURNING id INTO v_cortesia_id;

  v_result := jsonb_build_object(
    'success', true,
    'reembolso_id', v_res->>'reembolso_id',
    'cortesia_id', v_cortesia_id,
    'monto_centavos', v_monto
  );
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$function$;

-- ── cancelar_venta_producto ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancelar_venta_producto(p_pago_id uuid, p_motivo text, p_operation_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_pago   pagos;
  v_mov    record;
  v_reembolso jsonb;
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden cancelar una venta';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: Una cancelación sin motivo no se puede auditar después';
  END IF;

  SELECT * INTO v_pago FROM pagos WHERE id = p_pago_id;
  IF v_pago.id IS NULL THEN
    RAISE EXCEPTION 'PAGO_NO_EXISTE: No encontramos esa venta';
  END IF;
  IF v_pago.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esa venta es de otro gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_pago.sucursal_id);
  IF v_pago.concepto <> 'producto' THEN
    RAISE EXCEPTION 'NO_ES_VENTA_PRODUCTO: Ese cobro no es una venta de la tienda';
  END IF;

  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'cancelar_venta', get_my_user_id(),
      md5(jsonb_build_object('pago', p_pago_id, 'motivo', trim(p_motivo))::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  -- Anidado SIN key.
  v_reembolso := registrar_reembolso(p_pago_id, NULL, p_motivo);

  FOR v_mov IN
    SELECT producto_id, sucursal_id, cantidad
    FROM producto_movimientos
    WHERE pago_id = p_pago_id AND tipo = 'venta'
  LOOP
    INSERT INTO producto_movimientos (tenant_id, producto_id, sucursal_id, tipo, cantidad, motivo, created_by)
    VALUES (
      v_tenant, v_mov.producto_id, v_mov.sucursal_id, 'devolucion',
      -v_mov.cantidad,
      'Cancelación de venta: ' || trim(p_motivo), get_my_user_id()
    );
  END LOOP;

  v_result := jsonb_build_object('ok', true, 'reembolso', v_reembolso);
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$function$;

-- ── recepcion_ajustar_creditos ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recepcion_ajustar_creditos(p_usuario_id uuid, p_delta integer, p_motivo text, p_operation_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_actor  uuid := get_my_user_id();
  v_mem RECORD;
  v_saldo_anterior integer;
  v_saldo_nuevo integer;
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para ajustar créditos';
  END IF;
  IF p_delta IS NULL OR p_delta = 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA: el ajuste debe ser distinto de 0 (usá + para sumar, − para quitar)';
  END IF;

  SELECT m.id, m.status, m.tenant_id, m.creditos_restantes, t.tipo, u.nombre, m.sucursal_id
  INTO v_mem
  FROM membresias m
  JOIN tiers t   ON t.id = m.tier_id
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_mem.sucursal_id);
  IF v_mem.tipo = 'tiempo' THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_RECARGABLE: el plan es por tiempo, no usa créditos';
  END IF;
  IF v_mem.status NOT IN ('activa', 'congelada') THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_RECARGABLE: la membresía no está activa ni pausada';
  END IF;

  -- Idempotencia (W1): reclamar la operación o converger a la existente.
  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'credito_ajuste', v_actor,
      md5(jsonb_build_object('membresia', v_mem.id, 'delta', p_delta, 'motivo', p_motivo)::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  v_saldo_anterior := COALESCE(v_mem.creditos_restantes, 0);

  -- Puerta canónica: FOR UPDATE + veto de saldo negativo (D2) + asiento 'ajuste'.
  v_saldo_nuevo := _aplicar_credito(v_mem.id, p_delta, 'ajuste', p_motivo, NULL, NULL, v_actor);

  PERFORM _audrec_log(
    'membresia.ajustar_creditos', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Ajustó %s créditos. Motivo: %s', p_delta, p_motivo),
    jsonb_build_object('delta', p_delta, 'motivo', p_motivo,
                       'saldo_anterior', v_saldo_anterior, 'saldo_nuevo', v_saldo_nuevo)
  );

  v_result := jsonb_build_object('success', true, 'saldo_nuevo', v_saldo_nuevo);
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$function$;

-- ── recepcion_recargar_creditos ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recepcion_recargar_creditos(p_usuario_id uuid, p_cantidad integer, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
  v_saldo_anterior integer;
  v_saldo_nuevo integer;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para recargar créditos';
  END IF;
  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA: la cantidad debe ser mayor a 0';
  END IF;

  SELECT m.id, m.status, m.tenant_id, m.creditos_restantes, t.tipo, u.nombre, m.sucursal_id
  INTO v_mem
  FROM membresias m
  JOIN tiers t   ON t.id = m.tier_id
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_mem.sucursal_id);
  IF v_mem.tipo = 'tiempo' THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_RECARGABLE: el plan es por tiempo, no usa créditos';
  END IF;
  IF v_mem.status NOT IN ('activa', 'congelada') THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_RECARGABLE: la membresía no está activa ni pausada';
  END IF;

  v_saldo_anterior := COALESCE(v_mem.creditos_restantes, 0);

  -- W4-B: saldo + asiento por la puerta canónica (atómico, con FOR UPDATE y veto
  -- de saldo negativo). Sustituye el UPDATE + INSERT inline previos.
  v_saldo_nuevo := _aplicar_credito(v_mem.id, p_cantidad, 'ajuste', p_motivo, NULL, NULL, get_my_user_id());

  PERFORM _audrec_log(
    'membresia.recargar_creditos', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Recargó %s créditos. Motivo: %s', p_cantidad, p_motivo),
    jsonb_build_object('cantidad', p_cantidad, 'motivo', p_motivo,
                       'saldo_anterior', v_saldo_anterior, 'saldo_nuevo', v_saldo_nuevo)
  );

  RETURN jsonb_build_object('success', true, 'saldo_nuevo', v_saldo_nuevo);
END;
$function$;

-- ── gestionar_membresia_socio ─────────────────────────────────────────────
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
BEGIN
  v_actor_id := get_my_user_id();
  v_actor_tenant_id := get_my_tenant_id();
  IF v_actor_id IS NULL OR v_actor_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
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
    v_monto_plan := COALESCE(p_monto_centavos, v_tier.precio_centavos, 0);
    SELECT sucursal_id INTO v_sucursal_id FROM membresias WHERE id = v_membresia_id;

    IF v_monto_plan > 0 THEN
      INSERT INTO pagos (
        tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
        concepto, monto_centavos, moneda, metodo, notas, cobrado_por
      ) VALUES (
        v_socio.tenant_id, v_sucursal_id, p_usuario_id, v_membresia_id, p_tier_id,
        CASE WHEN v_tier.tipo IN ('creditos', 'hibrido') THEN 'paquete' ELSE 'plan' END,
        v_monto_plan, COALESCE(v_tier.moneda, 'MXN'), p_metodo_pago, v_motivo_final, v_actor_id
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
    'inscripcion_centavos', CASE WHEN v_cobra_inscripcion THEN v_inscripcion ELSE 0 END
  );
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_actor_tenant_id, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$function$;

-- ── recepcion_congelar_membresia ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recepcion_congelar_membresia(p_usuario_id uuid, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para congelar';
  END IF;

  SELECT m.id, m.status, m.tenant_id, u.nombre, m.sucursal_id
  INTO v_mem
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_mem.sucursal_id);
  IF v_mem.status = 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_PAUSADA: la membresía ya estaba pausada';
  END IF;
  IF v_mem.status <> 'activa' THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_CONGELABLE: solo una membresía activa se puede pausar';
  END IF;

  UPDATE membresias
  SET status = 'congelada', congelada_at = now(), updated_at = now()
  WHERE id = v_mem.id;

  PERFORM _audrec_log(
    'membresia.congelar', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Pausó la membresía. Motivo: %s', p_motivo),
    jsonb_build_object('motivo', p_motivo, 'status_anterior', 'activa')
  );

  RETURN jsonb_build_object('success', true, 'status', 'congelada');
END;
$function$;

-- ── recepcion_reactivar_membresia ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recepcion_reactivar_membresia(p_usuario_id uuid, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
  v_extension interval;
  v_dias numeric;
  v_nuevo_fin timestamptz;
  v_status_final text;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para reactivar';
  END IF;

  SELECT m.id, m.status, m.tenant_id, m.periodo_actual_fin, m.congelada_at, u.nombre, m.sucursal_id
  INTO v_mem
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_mem.sucursal_id);
  IF v_mem.status <> 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_ACTIVA: la membresía no estaba pausada';
  END IF;

  v_extension := CASE
    WHEN v_mem.congelada_at IS NOT NULL THEN now() - v_mem.congelada_at
    ELSE interval '0'
  END;
  v_dias := round(extract(epoch FROM v_extension) / 86400.0, 1);

  v_nuevo_fin := CASE
    WHEN v_mem.periodo_actual_fin IS NOT NULL THEN v_mem.periodo_actual_fin + v_extension
    ELSE NULL
  END;
  v_status_final := CASE
    WHEN v_nuevo_fin IS NOT NULL AND v_nuevo_fin <= now() THEN 'expirada'
    ELSE 'activa'
  END;

  UPDATE membresias
  SET status = v_status_final,
      periodo_actual_fin = v_nuevo_fin,
      congelada_at = NULL,
      updated_at = now()
  WHERE id = v_mem.id;

  PERFORM _audrec_log(
    'membresia.reactivar', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Reactivó la membresía (se extendió el vencimiento %s días por la pausa)%s. Motivo: %s',
           v_dias,
           CASE WHEN v_status_final = 'expirada' THEN ' — quedó VENCIDA (ya estaba vencida al reactivar)' ELSE '' END,
           p_motivo),
    jsonb_build_object('motivo', p_motivo, 'status_anterior', 'congelada',
                       'status_final', v_status_final, 'dias_extendidos', v_dias)
  );

  RETURN jsonb_build_object('success', true, 'status', v_status_final, 'dias_extendidos', v_dias);
END;
$function$;

-- ── recepcion_cancelar_membresia ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recepcion_cancelar_membresia(p_usuario_id uuid, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para cancelar la membresía';
  END IF;

  SELECT m.id, m.status, m.tenant_id, u.nombre, m.sucursal_id
  INTO v_mem
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_mem.sucursal_id);
  IF v_mem.status = 'cancelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_CANCELADA: la membresía ya estaba cancelada';
  END IF;

  UPDATE membresias
  SET status = 'cancelada', cancelada_at = now(), updated_at = now()
  WHERE id = v_mem.id;

  -- Cache: el trigger de W5-B también lo limpia; se mantiene por robustez.
  UPDATE usuarios
  SET membresia_tier = NULL, membresia_activa_id = NULL
  WHERE id = p_usuario_id;

  -- #17A-2: la membresía perdió entitlement de verdad (cancelación inmediata) →
  -- liberar sus reservas futuras membership-dependent sin débito.
  PERFORM _liberar_reservas_membresia(v_mem.id);

  PERFORM _audrec_log(
    'membresia.cancelar', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Canceló la membresía. Motivo: %s', p_motivo),
    jsonb_build_object('motivo', p_motivo, 'status_anterior', v_mem.status)
  );

  RETURN jsonb_build_object('success', true, 'status', 'cancelada');
END;
$function$;

-- ── cancelar_reserva_atomic ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancelar_reserva_atomic(p_reserva_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_user_rol text;
  v_reserva reservas;
  v_tenant tenants;
  v_now timestamptz := now();

  -- Ventana
  v_ventana_h integer;
  v_es_a_tiempo boolean;

  -- Dueño de la reserva (puede ser distinto del que cancela)
  v_owner_id uuid;
  v_owner_rol text;

  -- Membresía + ledger del dueño
  v_mem_id uuid;
  v_mem_status text;
  v_tier_tipo text;
  v_debit_count integer;
  v_refund_count integer;

  -- D-011: fallback al origen lista_espera
  v_le_origen uuid;

  -- Resultado de la devolución
  v_devolver boolean := false;
  v_devolucion_motivo text := 'no_aplica';
  v_nuevo_creditos integer;
  v_monto integer;  -- FIX: titular + invitados (espeja el débito de la reserva)
BEGIN
  v_user_id := get_my_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT rol INTO v_user_rol FROM usuarios WHERE id = v_user_id;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;
  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.usuario_id <> v_user_id AND NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: No puedes cancelar esta reserva';
  END IF;

  IF v_reserva.usuario_id <> v_user_id AND v_reserva.tenant_id <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: Esta reserva es de otro gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_reserva.clase_id));

  IF v_reserva.status <> 'confirmada' THEN
    RAISE EXCEPTION 'RESERVA_NO_CANCELABLE: La reserva no está confirmada (status: %)', v_reserva.status;
  END IF;

  IF v_reserva.slot_inicio <= v_now THEN
    RAISE EXCEPTION 'RESERVA_PASADA: No podés cancelar una reserva cuya clase ya empezó';
  END IF;

  -- Ventana de cancelación (solo decide la devolución, no bloquea).
  SELECT * INTO v_tenant FROM tenants WHERE id = v_reserva.tenant_id;
  v_ventana_h := COALESCE(
    (v_tenant.config->'reserva'->>'cancelacion_min_horas')::integer,
    4
  );
  v_es_a_tiempo := v_now < (v_reserva.slot_inicio - (v_ventana_h || ' hours')::interval);

  -- Lo debitado al reservar fue 1 (titular) + invitados. Se devuelve lo mismo.
  v_monto := 1 + COALESCE(v_reserva.invitados_count, 0);

  -- Devolución de crédito (al DUEÑO, no a quien cancela).
  v_owner_id := v_reserva.usuario_id;
  SELECT rol INTO v_owner_rol FROM usuarios WHERE id = v_owner_id;

  IF v_owner_rol = 'miembro' THEN
    SELECT m.id, m.status, t.tipo
    INTO v_mem_id, v_mem_status, v_tier_tipo
    FROM membresias m
    JOIN tiers t ON t.id = m.tier_id
    WHERE m.usuario_id = v_owner_id
      AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
    ORDER BY
      CASE m.status
        WHEN 'activa'    THEN 0
        WHEN 'trialing'  THEN 1
        WHEN 'past_due'  THEN 2
        WHEN 'congelada' THEN 3
      END,
      m.created_at DESC
    LIMIT 1
    FOR UPDATE OF m;

    IF v_mem_id IS NOT NULL AND v_tier_tipo IN ('creditos', 'hibrido') THEN
      SELECT count(*) INTO v_debit_count
      FROM membresia_movimientos
      WHERE membresia_id = v_mem_id
        AND reserva_id = p_reserva_id
        AND tipo = 'debito';

      SELECT count(*) INTO v_refund_count
      FROM membresia_movimientos
      WHERE membresia_id = v_mem_id
        AND reserva_id = p_reserva_id
        AND tipo = 'devolucion';

      -- D-011 FALLBACK — reserva nacida de una promoción de lista de espera:
      -- el débito quedó atado al lista_espera_id, no al reserva_id.
      IF v_debit_count = 0 THEN
        SELECT le.id INTO v_le_origen
        FROM lista_espera le
        WHERE le.reserva_id = p_reserva_id
          AND le.status = 'promovido'
        LIMIT 1;

        IF v_le_origen IS NOT NULL THEN
          SELECT count(*) INTO v_debit_count
          FROM membresia_movimientos
          WHERE membresia_id = v_mem_id
            AND lista_espera_id = v_le_origen
            AND tipo = 'debito';

          SELECT count(*) INTO v_refund_count
          FROM membresia_movimientos
          WHERE membresia_id = v_mem_id
            AND lista_espera_id = v_le_origen
            AND tipo = 'devolucion';
        END IF;
      END IF;

      IF v_debit_count > 0 AND v_refund_count = 0 THEN
        IF v_es_a_tiempo THEN
          v_devolver := true;
          v_devolucion_motivo := 'a_tiempo';
        ELSE
          v_devolucion_motivo := 'tarde';
        END IF;
      ELSE
        v_devolucion_motivo := 'sin_credito';
      END IF;
    ELSE
      v_devolucion_motivo := 'sin_credito';
    END IF;
  END IF;

  UPDATE reservas
  SET status = 'cancelada',
      cancelada_at = v_now,
      cancelada_motivo = p_motivo,
      cancelada_por = v_user_id
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  IF v_devolver THEN
    UPDATE membresias
    SET creditos_restantes = COALESCE(creditos_restantes, 0) + v_monto
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, lista_espera_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_reserva.tenant_id, 'devolucion', v_monto,
      p_reserva_id, v_le_origen,
      CASE
        WHEN v_le_origen IS NOT NULL THEN
          'cancelación a tiempo de reserva promovida ' || COALESCE(v_reserva.folio, '(sin folio)')
        ELSE
          'cancelación a tiempo de reserva ' || COALESCE(v_reserva.folio, '(sin folio)')
      END
        || CASE WHEN COALESCE(v_reserva.invitados_count, 0) > 0
             THEN ' (+' || v_reserva.invitados_count || ' invitado(s))' ELSE '' END,
      v_user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', p_reserva_id,
    'status', v_reserva.status,
    'devuelto', v_devolver,
    'devolucion_motivo', v_devolucion_motivo,
    'ventana_horas', v_ventana_h,
    'creditos_devueltos', CASE WHEN v_devolver THEN v_monto ELSE 0 END,
    'creditos_restantes', v_nuevo_creditos
  );
END;
$function$;

-- ── recepcion_marcar_no_show ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recepcion_marcar_no_show(p_reserva_id uuid, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_res RECORD;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;

  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    p_motivo := 'Marcado como no-show por recepción';
  END IF;

  SELECT r.id, r.status, r.tenant_id, r.usuario_id, r.slot_inicio, r.recurso_id, u.nombre, r.clase_id
  INTO v_res
  FROM reservas r
  LEFT JOIN usuarios u ON u.id = r.usuario_id
  WHERE r.id = p_reserva_id;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: no encontramos esa reserva';
  END IF;
  IF v_res.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: esa reserva no pertenece a tu negocio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_res.clase_id));
  IF v_res.status <> 'confirmada' THEN
    RAISE EXCEPTION 'RESERVA_NO_MARCABLE: solo una reserva confirmada se puede marcar como no-show (status actual: %)', v_res.status;
  END IF;

  -- La asistencia se computa desde reservas.status='no_show'; la columna
  -- contadora deprecada (20260519000000) ya no se toca.
  UPDATE reservas SET status = 'no_show', updated_at = now() WHERE id = p_reserva_id;

  -- Traza en el ledger: el crédito debitado se quema (penalización), delta 0.
  PERFORM _registrar_no_show_ledger(p_reserva_id, get_my_user_id());

  PERFORM _audrec_log(
    'clase.marcar_no_show', 'reserva', p_reserva_id, v_res.usuario_id, v_res.nombre,
    format('Marcó no-show de la reserva del %s. Motivo: %s',
           to_char(v_res.slot_inicio, 'DD/MM HH24:MI'), p_motivo),
    jsonb_build_object('slot_inicio', v_res.slot_inicio, 'recurso_id', v_res.recurso_id, 'motivo', p_motivo)
  );

  RETURN jsonb_build_object('success', true, 'status', 'no_show');
END;
$function$;

-- ── cancelar_reserva_admin ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancelar_reserva_admin(p_reserva_id uuid, p_motivo text DEFAULT NULL::text, p_notificar boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_actor uuid := get_my_user_id();
  v_motivo text := COALESCE(NULLIF(trim(p_motivo), ''), 'Cancelada por el gimnasio');
  v_res reservas;
  v_clase_nombre text;
  v_socio_nombre text;
  v_mem_id uuid; v_tier_tipo text; v_debit integer; v_refund integer; v_monto integer;
  v_devolvio boolean := false;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden cancelar una reserva';
  END IF;

  SELECT * INTO v_res FROM reservas WHERE id = p_reserva_id;
  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: no encontramos esa reserva';
  END IF;
  IF v_res.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: esa reserva no pertenece a tu negocio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_res.clase_id));
  IF v_res.status <> 'confirmada' THEN
    RAISE EXCEPTION 'RESERVA_NO_CANCELABLE: la reserva no está confirmada (status: %)', v_res.status;
  END IF;

  SELECT nombre INTO v_clase_nombre FROM clases WHERE id = v_res.clase_id;
  SELECT nombre INTO v_socio_nombre FROM usuarios WHERE id = v_res.usuario_id;

  -- Cancelar. El trigger reservas_promover_lista_espera promueve al siguiente en
  -- cola (correcto: liberamos UN lugar, no cancelamos la clase).
  UPDATE reservas
  SET status = 'cancelada_admin', cancelada_at = now(),
      cancelada_motivo = v_motivo, cancelada_por = v_actor
  WHERE id = p_reserva_id;

  -- Devolución del crédito (cancelación del gimnasio = SIEMPRE, sin ventana).
  IF (SELECT rol FROM usuarios WHERE id = v_res.usuario_id) = 'miembro' THEN
    SELECT m.id, t.tipo INTO v_mem_id, v_tier_tipo
    FROM membresias m JOIN tiers t ON t.id = m.tier_id
    WHERE m.usuario_id = v_res.usuario_id
      AND m.status IN ('trialing','activa','past_due','congelada')
    ORDER BY CASE m.status WHEN 'activa' THEN 0 WHEN 'trialing' THEN 1 WHEN 'past_due' THEN 2 WHEN 'congelada' THEN 3 END,
             m.created_at DESC
    LIMIT 1 FOR UPDATE OF m;

    IF v_mem_id IS NOT NULL AND v_tier_tipo IN ('creditos','hibrido') THEN
      SELECT count(*) INTO v_debit FROM membresia_movimientos
        WHERE membresia_id = v_mem_id AND reserva_id = p_reserva_id AND tipo = 'debito';
      SELECT count(*) INTO v_refund FROM membresia_movimientos
        WHERE membresia_id = v_mem_id AND reserva_id = p_reserva_id AND tipo = 'devolucion';
      IF v_debit > 0 AND v_refund = 0 THEN
        v_monto := 1 + COALESCE(v_res.invitados_count, 0);  -- espeja el débito
        UPDATE membresias SET creditos_restantes = COALESCE(creditos_restantes,0) + v_monto
          WHERE id = v_mem_id;
        INSERT INTO membresia_movimientos (
          membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
        ) VALUES (
          v_mem_id, v_tenant, 'devolucion', v_monto, p_reserva_id,
          'cancelación del gimnasio (' || COALESCE(v_clase_nombre, '') || ')', v_actor
        );
        v_devolvio := true;
      END IF;
    END IF;
  END IF;

  -- Notificación al socio.
  IF p_notificar THEN
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      v_tenant, v_res.usuario_id, 'reserva_cancelada', 'Reserva cancelada',
      'El gimnasio canceló tu reserva'
        || CASE WHEN v_clase_nombre IS NOT NULL THEN ' de ' || v_clase_nombre ELSE '' END || '.'
        || CASE WHEN v_devolvio THEN ' Se te devolvió el crédito.' ELSE '' END,
      jsonb_build_object('reserva_id', p_reserva_id, 'clase_id', v_res.clase_id)
    );
  END IF;

  PERFORM _audrec_log(
    'reserva.cancelar', 'reserva', p_reserva_id, v_res.usuario_id, v_socio_nombre,
    format('Canceló la reserva del %s%s. Motivo: %s',
           to_char(v_res.slot_inicio, 'DD/MM HH24:MI'),
           CASE WHEN v_devolvio THEN ' (crédito devuelto)' ELSE '' END, v_motivo),
    jsonb_build_object('reserva_id', p_reserva_id, 'devuelto', v_devolvio, 'motivo', v_motivo)
  );

  RETURN jsonb_build_object('success', true, 'reserva_id', p_reserva_id, 'devuelto', v_devolvio);
END $function$;

-- ── recepcion_corregir_checkin ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recepcion_corregir_checkin(p_reserva_id uuid, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_res RECORD;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para corregir un check-in';
  END IF;

  -- W2-03: FOR UPDATE OF r serializa la corrección contra un check-in concurrente.
  SELECT r.id, r.status, r.tenant_id, r.usuario_id, r.slot_inicio,
         r.check_in_at, r.check_in_by, r.check_in_method, u.nombre, r.clase_id
  INTO v_res
  FROM reservas r
  LEFT JOIN usuarios u ON u.id = r.usuario_id
  WHERE r.id = p_reserva_id
  FOR UPDATE OF r;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: no encontramos esa reserva';
  END IF;
  IF v_res.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: esa reserva no pertenece a tu negocio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_res.clase_id));
  IF v_res.status <> 'completada' THEN
    RAISE EXCEPTION 'CHECK_IN_NO_EXISTE: la reserva no tiene un check-in para corregir (status: %)', v_res.status;
  END IF;

  UPDATE reservas
  SET status = 'confirmada',
      check_in_at = NULL,
      check_in_by = NULL,
      check_in_method = NULL,
      updated_at = now()
  WHERE id = p_reserva_id;

  PERFORM _audrec_log(
    'checkin.corregir', 'reserva', p_reserva_id, v_res.usuario_id, v_res.nombre,
    format('Revirtió check-in de la reserva del %s. Motivo: %s',
           to_char(v_res.slot_inicio, 'DD/MM HH24:MI'), p_motivo),
    jsonb_build_object(
      'motivo', p_motivo,
      'check_in_anterior', jsonb_build_object(
        'check_in_at', v_res.check_in_at,
        'check_in_by', v_res.check_in_by,
        'check_in_method', v_res.check_in_method
      )
    )
  );

  RETURN jsonb_build_object('success', true, 'status', 'confirmada');
END;
$function$;

-- ── admin_marcar_asistencia ───────────────────────────────────────────────
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
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden corregir la asistencia';
  END IF;

  -- W2-03: FOR UPDATE (ver check_in_atomic).
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;
  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;
  IF v_reserva.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esta reserva pertenece a otro gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_reserva.clase_id));
  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este socio ya figura como presente';
  END IF;

  IF v_reserva.slot_inicio > now() THEN
    RAISE EXCEPTION 'CLASE_NO_INICIADA: Esa clase todavía no empieza; no se puede marcar asistencia';
  END IF;

  UPDATE reservas
  SET status = 'completada',
      check_in_at = now(),
      check_in_by = v_actor,
      check_in_method = 'manual',
      updated_at = now()
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;

  PERFORM _audrec_log(
    'clase.marcar_asistencia', 'reserva', p_reserva_id, v_reserva.usuario_id, v_miembro.nombre,
    format('Corrigió la asistencia a "presente" en la clase de %s.%s',
           to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI'),
           CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
                THEN ' Motivo: ' || p_motivo ELSE '' END),
    jsonb_build_object('motivo', p_motivo)
  );

  RETURN jsonb_build_object('success', true, 'reserva_id', p_reserva_id);
END;
$function$;

-- ── cambiar_lugar_reserva ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cambiar_lugar_reserva(p_reserva_id uuid, p_lugar_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor_tenant uuid := get_my_tenant_id();
  v_reserva reservas;
  v_recurso recursos;
BEGIN
  IF v_actor_tenant IS NULL OR NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción/admin puede cambiar lugares';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;
  IF v_reserva.id IS NULL OR v_reserva.tenant_id <> v_actor_tenant THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe en tu gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_reserva.clase_id));
  IF v_reserva.status NOT IN ('confirmada', 'completada') THEN
    RAISE EXCEPTION 'RESERVA_NO_ACTIVA: La reserva no está activa';
  END IF;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;
  IF v_recurso.layout IS NULL THEN
    RAISE EXCEPTION 'SALA_SIN_MAPA: Esta sala no usa Mapa de Salón';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') AS l
    WHERE l->>'id' = p_lugar_id
  ) THEN
    RAISE EXCEPTION 'LUGAR_INVALIDO: Ese lugar no existe en la sala';
  END IF;

  IF EXISTS (
    SELECT 1 FROM reservas
    WHERE clase_id = v_reserva.clase_id
      AND lugar_id = p_lugar_id
      AND status IN ('confirmada', 'completada')
      AND id <> p_reserva_id
  ) THEN
    RAISE EXCEPTION 'LUGAR_OCUPADO: Ese lugar ya está tomado';
  END IF;

  UPDATE reservas
  SET lugar_id = p_lugar_id, updated_at = now()
  WHERE id = p_reserva_id;

  RETURN jsonb_build_object('success', true, 'reserva_id', p_reserva_id, 'lugar_id', p_lugar_id);
END;
$function$;

-- ── recepcion_agregar_invitado ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recepcion_agregar_invitado(p_reserva_id uuid, p_nombre text, p_telefono text DEFAULT NULL::text, p_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_reserva reservas;
  v_nombre text := trim(COALESCE(p_nombre, ''));
  v_tel text := NULLIF(trim(COALESCE(p_telefono, '')), '');
  v_email text := NULLIF(lower(trim(COALESCE(p_email, ''))), '');
  v_socio uuid;
  v_creado boolean := false;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden agregar invitados';
  END IF;
  IF v_nombre = '' THEN
    RAISE EXCEPTION 'NOMBRE_REQUERIDO: El invitado necesita un nombre';
  END IF;
  IF v_tel IS NULL AND v_email IS NULL THEN
    RAISE EXCEPTION 'CONTACTO_REQUERIDO: El invitado necesita teléfono o email';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id AND tenant_id = v_tenant;
  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: Esa reserva no existe en tu gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_reserva.clase_id));

  -- ¿Ya existe un socio con ese email o teléfono? → ligar, no duplicar.
  SELECT id INTO v_socio
  FROM usuarios
  WHERE tenant_id = v_tenant AND rol = 'miembro'
    AND (
      (v_email IS NOT NULL AND lower(email) = v_email)
      OR (v_tel IS NOT NULL AND telefono = v_tel)
    )
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_socio IS NULL THEN
    INSERT INTO usuarios (tenant_id, nombre, email, telefono, rol, status, notas_admin)
    VALUES (
      v_tenant, v_nombre,
      COALESCE(v_email, 'invitado-' || gen_random_uuid() || '@sin-correo.local'),
      v_tel, 'miembro', 'activo',
      'Llegó como invitado el ' || to_char(now(), 'DD/MM/YYYY') || '. Sin plan todavía.'
    )
    RETURNING id INTO v_socio;
    v_creado := true;
  END IF;

  INSERT INTO reserva_invitados (tenant_id, reserva_id, nombre, telefono, email, usuario_id)
  VALUES (v_tenant, p_reserva_id, v_nombre, v_tel, v_email, v_socio);

  RETURN jsonb_build_object('success', true, 'usuario_id', v_socio, 'creado', v_creado);
END;
$function$;

-- ── cancelar_clase ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancelar_clase(p_clase_id uuid DEFAULT NULL::uuid, p_horario_id uuid DEFAULT NULL::uuid, p_fecha date DEFAULT NULL::date, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_actor uuid := get_my_user_id();
  v_clase_id uuid;
  v_clase clases;
  v_motivo text := COALESCE(NULLIF(trim(p_motivo), ''), 'Clase cancelada por el gimnasio');
  v_canceladas integer := 0;
  v_devueltos integer := 0;
  r RECORD;
  v_mem_id uuid; v_tier_tipo text; v_debit integer; v_refund integer; v_devolvio boolean;
  v_monto integer;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden cancelar una clase';
  END IF;

  IF p_clase_id IS NOT NULL THEN
    v_clase_id := p_clase_id;
  ELSIF p_horario_id IS NOT NULL AND p_fecha IS NOT NULL THEN
    v_clase_id := materializar_clase(p_horario_id, p_fecha);
  ELSE
    RAISE EXCEPTION 'PARAMS: se requiere p_clase_id o (p_horario_id, p_fecha)';
  END IF;

  SELECT * INTO v_clase FROM clases WHERE id = v_clase_id;
  IF v_clase.id IS NULL THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: no encontramos esa clase';
  END IF;
  IF v_clase.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: esa clase no pertenece a tu gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_clase.sucursal_id);
  IF v_clase.status = 'cancelada' THEN
    RAISE EXCEPTION 'CLASE_YA_CANCELADA: la clase ya estaba cancelada';
  END IF;

  -- ── Lista de espera PRIMERO (evita promoción fantasma): devolver 1 + cerrar ─
  FOR r IN
    SELECT * FROM lista_espera
    WHERE clase_id = v_clase_id AND status = 'esperando'
    FOR UPDATE
  LOOP
    IF (SELECT rol FROM usuarios WHERE id = r.usuario_id) = 'miembro' THEN
      SELECT m.id, t.tipo INTO v_mem_id, v_tier_tipo
      FROM membresias m JOIN tiers t ON t.id = m.tier_id
      WHERE m.usuario_id = r.usuario_id
        AND m.status IN ('trialing','activa','past_due','congelada')
      ORDER BY CASE m.status WHEN 'activa' THEN 0 WHEN 'trialing' THEN 1 WHEN 'past_due' THEN 2 WHEN 'congelada' THEN 3 END,
               m.created_at DESC
      LIMIT 1 FOR UPDATE OF m;

      IF v_mem_id IS NOT NULL AND v_tier_tipo IN ('creditos','hibrido') THEN
        SELECT count(*) INTO v_debit FROM membresia_movimientos
          WHERE membresia_id = v_mem_id AND lista_espera_id = r.id AND tipo = 'debito';
        SELECT count(*) INTO v_refund FROM membresia_movimientos
          WHERE membresia_id = v_mem_id AND lista_espera_id = r.id AND tipo = 'devolucion';
        IF v_debit > 0 AND v_refund = 0 THEN
          UPDATE membresias SET creditos_restantes = COALESCE(creditos_restantes,0) + 1
            WHERE id = v_mem_id;
          INSERT INTO membresia_movimientos (
            membresia_id, tenant_id, tipo, delta_creditos, reserva_id, lista_espera_id, motivo, created_by
          ) VALUES (
            v_mem_id, v_tenant, 'devolucion', 1, NULL, r.id,
            'clase cancelada — salía de lista de espera (' || COALESCE(v_clase.nombre,'') || ')', v_actor
          );
          v_devueltos := v_devueltos + 1;
        END IF;
      END IF;
    END IF;

    UPDATE lista_espera SET status = 'cancelado' WHERE id = r.id;

    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      v_tenant, r.usuario_id, 'clase_cancelada', 'Clase cancelada',
      'La clase ' || COALESCE(v_clase.nombre,'') || ' en la que esperabas lugar fue cancelada por el gimnasio.',
      jsonb_build_object('clase_id', v_clase_id, 'lista_espera_id', r.id)
    );
  END LOOP;

  -- ── Reservas confirmadas: cancelar + devolver (1 + invitados) + notificar ──
  FOR r IN
    SELECT * FROM reservas
    WHERE clase_id = v_clase_id AND status = 'confirmada'
    FOR UPDATE
  LOOP
    UPDATE reservas
    SET status = 'cancelada_admin', cancelada_at = now(),
        cancelada_motivo = v_motivo, cancelada_por = v_actor
    WHERE id = r.id;
    v_canceladas := v_canceladas + 1;

    v_devolvio := false;
    IF (SELECT rol FROM usuarios WHERE id = r.usuario_id) = 'miembro' THEN
      SELECT m.id, t.tipo INTO v_mem_id, v_tier_tipo
      FROM membresias m JOIN tiers t ON t.id = m.tier_id
      WHERE m.usuario_id = r.usuario_id
        AND m.status IN ('trialing','activa','past_due','congelada')
      ORDER BY CASE m.status WHEN 'activa' THEN 0 WHEN 'trialing' THEN 1 WHEN 'past_due' THEN 2 WHEN 'congelada' THEN 3 END,
               m.created_at DESC
      LIMIT 1 FOR UPDATE OF m;

      IF v_mem_id IS NOT NULL AND v_tier_tipo IN ('creditos','hibrido') THEN
        SELECT count(*) INTO v_debit FROM membresia_movimientos
          WHERE membresia_id = v_mem_id AND reserva_id = r.id AND tipo = 'debito';
        SELECT count(*) INTO v_refund FROM membresia_movimientos
          WHERE membresia_id = v_mem_id AND reserva_id = r.id AND tipo = 'devolucion';
        IF v_debit > 0 AND v_refund = 0 THEN
          v_monto := 1 + COALESCE(r.invitados_count, 0);  -- espeja el débito
          UPDATE membresias SET creditos_restantes = COALESCE(creditos_restantes,0) + v_monto
            WHERE id = v_mem_id;
          INSERT INTO membresia_movimientos (
            membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
          ) VALUES (
            v_mem_id, v_tenant, 'devolucion', v_monto, r.id,
            'clase cancelada (' || COALESCE(v_clase.nombre,'') || ')', v_actor
          );
          v_devueltos := v_devueltos + 1;
          v_devolvio := true;
        END IF;
      END IF;
    END IF;

    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      v_tenant, r.usuario_id, 'clase_cancelada', 'Clase cancelada',
      'Tu clase ' || COALESCE(v_clase.nombre,'') || ' fue cancelada por el gimnasio.'
        || CASE WHEN v_devolvio THEN ' Se te devolvió el crédito.' ELSE '' END,
      jsonb_build_object('clase_id', v_clase_id, 'reserva_id', r.id)
    );
  END LOOP;

  UPDATE clases
  SET status = 'cancelada', cancelada_at = now(), cancelada_motivo = v_motivo
  WHERE id = v_clase_id;

  PERFORM _audrec_log(
    'clase.cancelar', 'clase', v_clase_id, NULL, NULL,
    format('Canceló la clase "%s" del %s — %s reserva(s) cancelada(s), %s crédito(s) devuelto(s). Motivo: %s',
           COALESCE(v_clase.nombre,''), v_clase.fecha, v_canceladas, v_devueltos, v_motivo),
    jsonb_build_object('clase_id', v_clase_id, 'fecha', v_clase.fecha,
                       'reservas_canceladas', v_canceladas, 'creditos_devueltos', v_devueltos, 'motivo', v_motivo)
  );

  RETURN jsonb_build_object(
    'success', true, 'clase_id', v_clase_id,
    'reservas_canceladas', v_canceladas, 'creditos_devueltos', v_devueltos
  );
END $function$;

-- ── recepcion_crear_reserva ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recepcion_crear_reserva(p_usuario_id uuid, p_clase_id uuid DEFAULT NULL::uuid, p_horario_id uuid DEFAULT NULL::uuid, p_fecha date DEFAULT NULL::date, p_invitados integer DEFAULT 0, p_notas text DEFAULT NULL::text, p_lugar_id text DEFAULT NULL::text, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor_id uuid;
  v_tenant_id uuid;
  v_socio usuarios;
  v_clase clases;
  v_clase_id uuid;
  v_recurso recursos;
  v_now timestamptz := now();
  v_tz text;
  v_slot_inicio timestamptz;
  v_slot_fin timestamptz;
  v_cupos_ocupados integer;
  v_cupo_efectivo integer;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;

  v_mem_id uuid;
  v_mem_status text;
  v_mem_inicio timestamptz;
  v_mem_fin timestamptz;
  v_mem_creditos integer;
  v_tier_tipo text;
  v_tier_todas_sedes boolean;
  v_mem_sucursal uuid;
  v_nuevo_creditos integer;
  v_costo integer;

  v_inv_incluidos integer;
  v_inv_usados integer;
  v_inv_disponibles integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
BEGIN
  v_actor_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_actor_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden reservar por un socio';
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE: El socio no existe';
  END IF;
  IF v_socio.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: El socio es de otro gimnasio';
  END IF;
  IF v_socio.rol <> 'miembro' THEN
    RAISE EXCEPTION 'ROL_INVALIDO: Solo se reserva para socios';
  END IF;

  v_clase_id := p_clase_id;
  IF v_clase_id IS NULL THEN
    IF p_horario_id IS NULL OR p_fecha IS NULL THEN
      RAISE EXCEPTION 'CLASE_REQUERIDA: Falta la clase (o el horario + fecha)';
    END IF;
    v_clase_id := materializar_clase(p_horario_id, p_fecha);
  END IF;

  SELECT * INTO v_clase FROM clases WHERE id = v_clase_id;
  IF v_clase IS NULL OR v_clase.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: Esta clase no existe en tu gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_clase.sucursal_id);
  IF v_clase.status <> 'programada' THEN
    RAISE EXCEPTION 'CLASE_NO_PROGRAMADA: Esta clase no está disponible (status: %)', v_clase.status;
  END IF;

  v_tz := timezone_de_sucursal(v_clase.sucursal_id, v_clase.tenant_id);

  SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;
  IF v_recurso IS NULL OR NOT v_recurso.activo THEN
    RAISE EXCEPTION 'RECURSO_INACTIVO: Esta sala no está disponible';
  END IF;

  -- W2-01: serializa el cupo/asientos de ESTA clase (todas las salas), antes del
  -- check de lugar/cupo y antes del FOR UPDATE de la membresía. Mismo lock y orden
  -- que reservar_clase_atomic → sin deadlock. (Antes esta función no tenía lock.)
  PERFORM pg_advisory_xact_lock(hashtext('clase_lugares:' || v_clase_id::text));

  IF v_recurso.layout IS NOT NULL THEN
    IF p_invitados > 0 THEN
      RAISE EXCEPTION 'LUGAR_SIN_INVITADOS: En salas con lugar asignado, cada persona reserva su propio lugar';
    END IF;
    IF p_lugar_id IS NULL THEN
      RAISE EXCEPTION 'LUGAR_REQUERIDO: Elegí un lugar para esta clase';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') AS l
      WHERE l->>'id' = p_lugar_id
    ) THEN
      RAISE EXCEPTION 'LUGAR_INVALIDO: Ese lugar no existe en la sala';
    END IF;
    IF EXISTS (
      SELECT 1 FROM reservas
      WHERE clase_id = v_clase_id AND lugar_id = p_lugar_id
        AND status IN ('confirmada','completada')
    ) THEN
      RAISE EXCEPTION 'LUGAR_OCUPADO: Ese lugar ya está tomado, elegí otro';
    END IF;
  ELSE
    p_lugar_id := NULL;
  END IF;

  IF v_socio.bloqueado_hasta IS NOT NULL AND v_socio.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: El socio tiene una restricción hasta el %',
      to_char(v_socio.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  SELECT m.id, m.status, m.periodo_actual_inicio, m.periodo_actual_fin,
         m.creditos_restantes, t.tipo, t.acceso_todas_sucursales, m.sucursal_id,
         COALESCE(t.invitados_por_periodo, 0)
  INTO v_mem_id, v_mem_status, v_mem_inicio, v_mem_fin,
       v_mem_creditos, v_tier_tipo, v_tier_todas_sedes, v_mem_sucursal,
       v_inv_incluidos
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
  ORDER BY
    CASE m.status
      WHEN 'activa'    THEN 0
      WHEN 'trialing'  THEN 1
      WHEN 'past_due'  THEN 2
      WHEN 'congelada' THEN 3
    END,
    m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  IF v_mem_id IS NULL THEN
    RAISE EXCEPTION 'SIN_MEMBRESIA: El socio no tiene una membresía activa';
  END IF;
  IF v_mem_status = 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_CONGELADA: La membresía del socio está pausada';
  END IF;
  IF v_mem_fin IS NOT NULL AND v_mem_fin <= v_now THEN
    RAISE EXCEPTION 'MEMBRESIA_VENCIDA: La membresía venció el %',
      to_char(v_mem_fin AT TIME ZONE v_tz, 'DD/MM/YYYY');
  END IF;

  IF NOT _sala_permite_tier(v_recurso.tiers_permitidos, v_socio.membresia_tier) THEN
    RAISE EXCEPTION 'TIER_NO_PERMITIDO: El plan del socio no da acceso a esta sala';
  END IF;

  IF NOT COALESCE(v_tier_todas_sedes, true)
     AND v_mem_sucursal IS NOT NULL AND v_clase.sucursal_id IS NOT NULL
     AND v_mem_sucursal <> v_clase.sucursal_id THEN
    RAISE EXCEPTION 'SUCURSAL_NO_INCLUIDA: El plan del socio solo cubre su sede';
  END IF;

  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;

  IF p_invitados > 0 THEN
    IF COALESCE(v_inv_incluidos, 0) = 0 THEN
      RAISE EXCEPTION 'INVITADOS_NO_INCLUIDOS: El plan del socio no incluye pases de invitado';
    END IF;

    v_ventana_inicio := COALESCE(v_mem_inicio, date_trunc('month', v_now));
    v_ventana_fin    := COALESCE(v_mem_fin, v_ventana_inicio + interval '1 month');

    SELECT COALESCE(SUM(r.invitados_count), 0)
    INTO v_inv_usados
    FROM reservas r
    WHERE r.usuario_id = p_usuario_id
      AND r.status IN ('confirmada', 'completada', 'no_show')
      AND r.created_at >= v_ventana_inicio
      AND r.created_at <  v_ventana_fin;

    v_inv_disponibles := GREATEST(v_inv_incluidos - COALESCE(v_inv_usados, 0), 0);

    IF p_invitados > v_inv_disponibles THEN
      RAISE EXCEPTION
        'INVITADOS_EXCEDEN: El plan incluye % pase(s) por periodo y le quedan %',
        v_inv_incluidos, v_inv_disponibles;
    END IF;
  END IF;

  v_costo := 1 + p_invitados;
  IF v_tier_tipo IN ('creditos', 'hibrido')
     AND COALESCE(v_mem_creditos, 0) < v_costo THEN
    RAISE EXCEPTION 'SIN_CREDITOS: Necesita % clase(s) y le quedan %',
      v_costo, COALESCE(v_mem_creditos, 0);
  END IF;

  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  v_slot_fin    := v_slot_inicio + (v_clase.duracion_minutos || ' minutes')::interval;

  IF EXISTS (
    SELECT 1 FROM reservas
    WHERE clase_id = v_clase_id
      AND usuario_id = p_usuario_id
      AND status IN ('confirmada','completada')
  ) THEN
    RAISE EXCEPTION 'YA_RESERVADO: El socio ya tiene una reserva en esta clase';
  END IF;

  SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = v_clase_id
    AND status IN ('confirmada','completada');

  v_cupo_efectivo := CASE
    WHEN v_recurso.layout IS NOT NULL
      THEN COALESCE(jsonb_array_length(v_recurso.layout->'lugares'), v_clase.cupo_max)
    ELSE v_clase.cupo_max
  END;

  IF v_cupos_ocupados + 1 + p_invitados > v_cupo_efectivo THEN
    RAISE EXCEPTION 'CUPO_LLENO: Esta clase está llena (% / %)', v_cupos_ocupados, v_cupo_efectivo;
  END IF;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'SAL-' || lpad((v_folio_count + 1)::text, 6, '0');

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, notas,
    clase_id, lugar_id,
    membresia_id, entitlement_source
  ) VALUES (
    v_tenant_id, v_clase.recurso_id, p_usuario_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    p_invitados, 'confirmada', v_folio_nuevo,
    COALESCE(NULLIF(trim(p_notas), ''), 'Walk-in en mostrador'),
    v_clase_id, p_lugar_id,
    -- #17A-1: esta ruta exige rol='miembro' con membresía validada más arriba
    -- (ROL_INVALIDO/SIN_MEMBRESIA abortan antes) → siempre 'membership'.
    v_mem_id, 'membership'
  )
  RETURNING id INTO v_reserva_id;

  IF v_tier_tipo IN ('creditos', 'hibrido') THEN
    UPDATE membresias
    SET creditos_restantes = creditos_restantes - v_costo
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_tenant_id, 'debito', -v_costo,
      v_reserva_id,
      'reserva ' || v_folio_nuevo || ' (mostrador)'
        || CASE WHEN p_invitados > 0 THEN ' (+' || p_invitados || ' invitado(s))' ELSE '' END,
      v_actor_id
    );
  END IF;

  PERFORM _audrec_log(
    'reserva.crear',
    'reserva',
    v_reserva_id,
    p_usuario_id,
    v_socio.nombre,
    format('Creó una reserva en el mostrador (%s). Motivo: %s',
           v_clase.nombre, COALESCE(NULLIF(trim(p_motivo), ''), 'walk-in')),
    jsonb_build_object(
      'clase_id', v_clase_id,
      'folio', v_folio_nuevo,
      'invitados', p_invitados,
      'motivo', p_motivo
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo,
    'clase_id', v_clase_id,
    'creditos_restantes', v_nuevo_creditos
  );
END;
$function$;

-- ── marcar_entregado ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.marcar_entregado(p_entrega_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller usuarios;
  v_entrega tienda_entregas;
BEGIN
  SELECT * INTO v_caller FROM usuarios WHERE auth_id = auth.uid();
  IF v_caller.id IS NULL OR v_caller.rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;
  SELECT * INTO v_entrega FROM tienda_entregas WHERE id = p_entrega_id;
  IF v_entrega.id IS NULL OR v_entrega.tenant_id <> v_caller.tenant_id THEN
    RAISE EXCEPTION 'ENTREGA_INVALIDA';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_entrega.sucursal_id);
  IF v_entrega.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'YA_RESUELTA';
  END IF;
  UPDATE tienda_entregas
  SET estado = 'entregado', entregado_por = v_caller.id, entregado_at = now()
  WHERE id = p_entrega_id;
END; $function$;

-- ── vender_productos ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.vender_productos(p_sucursal_id uuid, p_metodo text, p_items jsonb, p_usuario_id uuid DEFAULT NULL::uuid, p_operation_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller usuarios;
  v_item jsonb;
  v_prod productos;
  v_cant integer;
  v_total integer := 0;
  v_moneda text := 'MXN';
  v_pago_id uuid;
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  SELECT * INTO v_caller FROM usuarios WHERE auth_id = auth.uid();
  IF v_caller.id IS NULL OR v_caller.rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden vender';
  END IF;
  IF v_caller.status <> 'activo' THEN
    RAISE EXCEPTION 'CUENTA_INACTIVA';
  END IF;

  IF p_metodo NOT IN ('efectivo', 'tarjeta', 'transferencia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO';
  END IF;
  IF jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'SIN_ITEMS';
  END IF;

  -- Idempotencia. Los items no tienen orden semántico → se canonicalizan ordenados
  -- por producto_id antes de hashear.
  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_caller.tenant_id, p_operation_key, 'pos_venta', v_caller.id,
      md5(jsonb_build_object(
        'sucursal', p_sucursal_id, 'metodo', p_metodo, 'usuario', p_usuario_id,
        'items', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('p', e->>'producto_id', 'c', e->>'cantidad') ORDER BY e->>'producto_id')
          FROM jsonb_array_elements(p_items) e
        ), '[]'::jsonb)
      )::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  IF p_sucursal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sucursales WHERE id = p_sucursal_id AND tenant_id = v_caller.tenant_id
  ) THEN
    RAISE EXCEPTION 'SUCURSAL_INVALIDA: esa sucursal no es de este gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion_param(p_sucursal_id);
  IF p_usuario_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM usuarios WHERE id = p_usuario_id AND tenant_id = v_caller.tenant_id
  ) THEN
    RAISE EXCEPTION 'SOCIO_INVALIDO: ese socio no es de este gimnasio';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_prod FROM productos WHERE id = (v_item->>'producto_id')::uuid;
    IF v_prod.id IS NULL OR v_prod.tenant_id <> v_caller.tenant_id THEN
      RAISE EXCEPTION 'PRODUCTO_INVALIDO';
    END IF;
    IF v_prod.activo IS NOT TRUE THEN
      RAISE EXCEPTION 'PRODUCTO_INACTIVO: %', v_prod.nombre;
    END IF;
    v_cant := COALESCE((v_item->>'cantidad')::integer, 0);
    IF v_cant <= 0 THEN
      RAISE EXCEPTION 'CANTIDAD_INVALIDA';
    END IF;
    v_total := v_total + v_prod.precio_centavos * v_cant;
    v_moneda := v_prod.moneda;
  END LOOP;

  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id, concepto, monto_centavos, moneda, metodo, cobrado_por
  ) VALUES (
    v_caller.tenant_id, p_sucursal_id, p_usuario_id, 'producto', v_total, v_moneda, p_metodo, v_caller.id
  )
  RETURNING id INTO v_pago_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO producto_movimientos (
      tenant_id, producto_id, sucursal_id, tipo, cantidad, pago_id, created_by
    ) VALUES (
      v_caller.tenant_id, (v_item->>'producto_id')::uuid, p_sucursal_id,
      'venta', -((v_item->>'cantidad')::integer), v_pago_id, v_caller.id
    );
  END LOOP;

  v_result := jsonb_build_object('pago_id', v_pago_id, 'total_centavos', v_total, 'moneda', v_moneda);
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_caller.tenant_id, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END; $function$;

-- ── hacer_corte_caja ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hacer_corte_caja(p_desde timestamp with time zone, p_hasta timestamp with time zone, p_sucursal_id uuid DEFAULT NULL::uuid, p_efectivo_contado_centavos integer DEFAULT 0, p_fondo_centavos integer DEFAULT 0, p_notas text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid; v_actor uuid;
  v_esperado integer; v_dif integer; v_id uuid; v_resumen jsonb;
BEGIN
  IF NOT is_recepcionista() THEN RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin'; END IF;
  v_tenant := get_my_tenant_id();
  v_actor  := get_my_user_id();

  IF p_efectivo_contado_centavos < 0 OR p_fondo_centavos < 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO: los montos no pueden ser negativos';
  END IF;
  IF p_hasta <= p_desde THEN
    RAISE EXCEPTION 'RANGO_INVALIDO: la fecha final debe ser mayor que la inicial';
  END IF;
  IF p_sucursal_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM sucursales WHERE id = p_sucursal_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'SUCURSAL_INVALIDA';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion_param(p_sucursal_id);

  -- W2-02: serializa el corte por TENANT. Nivel tenant (no sucursal) a propósito:
  -- un corte "todas las sedes" (sucursal NULL) lee los pagos de todas las
  -- sucursales, así que debe entrar en conflicto con cualquier corte por-sucursal
  -- del mismo tenant. Un único lock por tenant garantiza ese conflicto sin riesgo
  -- de deadlock. NO impide periodos solapados (los cortes son reportes): solo
  -- evita que dos cortes del mismo tenant calculen/inserten en paralelo.
  PERFORM pg_advisory_xact_lock(hashtext('corte:' || v_tenant::text));

  SELECT COALESCE(SUM(monto_centavos), 0) INTO v_esperado FROM pagos
   WHERE tenant_id = v_tenant AND metodo = 'efectivo'
     AND (p_sucursal_id IS NULL OR sucursal_id = p_sucursal_id)
     AND created_at >= p_desde AND created_at < p_hasta;

  v_dif := p_efectivo_contado_centavos - (v_esperado + p_fondo_centavos);
  v_resumen := _resumen_corte(v_tenant, p_sucursal_id, p_desde, p_hasta);

  INSERT INTO cortes_caja (
    tenant_id, sucursal_id, realizado_por, desde, hasta,
    efectivo_esperado_centavos, fondo_centavos, efectivo_contado_centavos, diferencia_centavos, notas, resumen
  ) VALUES (
    v_tenant, p_sucursal_id, v_actor, p_desde, p_hasta,
    v_esperado, p_fondo_centavos, p_efectivo_contado_centavos, v_dif, NULLIF(trim(p_notas), ''), v_resumen
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true, 'id', v_id, 'desde', p_desde, 'hasta', p_hasta,
    'efectivo_esperado_centavos', v_esperado, 'fondo_centavos', p_fondo_centavos,
    'efectivo_contado_centavos', p_efectivo_contado_centavos, 'diferencia_centavos', v_dif,
    'resumen', v_resumen
  );
END; $function$;

-- ── preview_corte_caja ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.preview_corte_caja(p_desde timestamp with time zone, p_hasta timestamp with time zone, p_sucursal_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid;
  v_esperado integer;
BEGIN
  IF NOT is_recepcionista() THEN RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin'; END IF;
  v_tenant := get_my_tenant_id();
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion_param(p_sucursal_id);

  SELECT COALESCE(SUM(monto_centavos), 0) INTO v_esperado FROM pagos
   WHERE tenant_id = v_tenant AND metodo = 'efectivo'
     AND (p_sucursal_id IS NULL OR sucursal_id = p_sucursal_id)
     AND created_at >= p_desde AND created_at < p_hasta;

  RETURN jsonb_build_object('efectivo_esperado_centavos', v_esperado);
END; $function$;

-- ── Self-test (devuelve TABLA; crea un tenant desechable y lo cierra) ────────
CREATE OR REPLACE FUNCTION _diag_branch_isolation()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_slug text := 'zz-b9iso-' || substr(md5(random()::text), 1, 6);
  v_t uuid; v_sa uuid; v_sb uuid; v_tier uuid;
  a_recep uuid := gen_random_uuid(); a_null uuid := gen_random_uuid(); a_admin uuid := gen_random_uuid();
  v_sock_b uuid; v_sock_a uuid; v_mem_b uuid;
  v_cargo_b uuid; v_cargo_a uuid;
  v_np int; v_np2 int; v_st text; v_err text; v_ok boolean;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug, 'B9 Iso', 'gym_libre', 'activo') RETURNING id INTO v_t;
  INSERT INTO sucursales (tenant_id, nombre, orden) VALUES (v_t, 'Sede A', 90) RETURNING id INTO v_sa;
  INSERT INTO sucursales (tenant_id, nombre, orden) VALUES (v_t, 'Sede B', 91) RETURNING id INTO v_sb;
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, clases_incluidas, periodo, activo)
  VALUES (v_t, 'b9-paq', 'Paquete', 100000, 'creditos', 10, 'mensual', true) RETURNING id INTO v_tier;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (a_recep, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_slug||'-ra@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'RecepA'), '', now(), now(), now()),
         (a_null,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_slug||'-rn@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'RecepNull'), '', now(), now(), now()),
         (a_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_slug||'-ad@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'), '', now(), now(), now());
  UPDATE usuarios SET rol = 'recepcionista', status = 'activo', sucursal_id = v_sa WHERE auth_id = a_recep;
  UPDATE usuarios SET rol = 'recepcionista', status = 'activo', sucursal_id = NULL WHERE auth_id = a_null;
  UPDATE usuarios SET rol = 'admin', status = 'activo' WHERE auth_id = a_admin;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status, sucursal_id) VALUES (v_t, v_slug||'-sb@x.dev', 'Socio B', 'miembro', 'activo', v_sb) RETURNING id INTO v_sock_b;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status, sucursal_id) VALUES (v_t, v_slug||'-sa@x.dev', 'Socio A', 'miembro', 'activo', v_sa) RETURNING id INTO v_sock_a;
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, sucursal_id, creditos_restantes, periodo_actual_inicio, periodo_actual_fin)
  VALUES (v_t, v_sock_b, v_tier, 'activa', v_sb, 10, now() - interval '1 day', now() + interval '29 days') RETURNING id INTO v_mem_b;
  INSERT INTO cargos_pendientes (tenant_id, sucursal_id, usuario_id, concepto, monto_centavos, descripcion)
  VALUES (v_t, v_sb, v_sock_b, 'otro', 5000, 'b9 cargo B') RETURNING id INTO v_cargo_b;
  INSERT INTO cargos_pendientes (tenant_id, sucursal_id, usuario_id, concepto, monto_centavos, descripcion)
  VALUES (v_t, v_sa, v_sock_a, 'otro', 5000, 'b9 cargo A') RETURNING id INTO v_cargo_a;

  -- ── Recepción sede A ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', a_recep::text)::text, true);

  SELECT count(*) INTO v_np FROM pagos WHERE tenant_id = v_t;
  v_err := NULL;
  BEGIN PERFORM cobrar_cargo_pendiente(v_cargo_b, 'efectivo', NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  SELECT count(*) INTO v_np2 FROM pagos WHERE tenant_id = v_t;
  SELECT estado INTO v_st FROM cargos_pendientes WHERE id = v_cargo_b;
  prueba := 'T1. recepción A cobra cargo de sede B → BLOCK, 0 pagos, cargo sigue pendiente';
  resultado := CASE WHEN v_err LIKE 'SUCURSAL_DIFERENTE%' AND v_np2 = v_np AND v_st = 'pendiente'
    THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)')||' pagos '||v_np||'→'||v_np2||' estado='||coalesce(v_st,'?') END;
  RETURN NEXT;

  v_err := NULL;
  BEGIN PERFORM cobrar_cargo_pendiente(v_cargo_a, 'efectivo', NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  SELECT estado INTO v_st FROM cargos_pendientes WHERE id = v_cargo_a;
  prueba := 'T2. recepción A cobra cargo de su sede → ALLOW';
  resultado := CASE WHEN v_err IS NULL AND v_st = 'cobrado' THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'-')||' estado='||coalesce(v_st,'?') END;
  RETURN NEXT;

  v_err := NULL;
  BEGIN PERFORM recepcion_congelar_membresia(v_sock_b, 'b9 test'); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  SELECT status INTO v_st FROM membresias WHERE id = v_mem_b;
  prueba := 'T3. recepción A congela membresía de sede B → BLOCK, sigue activa';
  resultado := CASE WHEN v_err LIKE 'SUCURSAL_DIFERENTE%' AND v_st = 'activa' THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)')||' status='||coalesce(v_st,'?') END;
  RETURN NEXT;

  v_ok := true;
  BEGIN PERFORM preview_corte_caja(now() - interval '1 day', now(), v_sa); EXCEPTION WHEN raise_exception THEN v_ok := false; END;
  v_err := NULL;
  BEGIN PERFORM preview_corte_caja(now() - interval '1 day', now(), v_sb); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  prueba := 'T4. preview_corte_caja: propia sede ALLOW, sede B BLOCK';
  resultado := CASE WHEN v_ok AND v_err LIKE 'SUCURSAL_PARAMETRO_INVALIDO%' THEN '✅ ok' ELSE '❌ propia='||v_ok||' err='||coalesce(v_err,'(ninguno)') END;
  RETURN NEXT;

  v_err := NULL;
  BEGIN PERFORM preview_corte_caja(now() - interval '1 day', now(), NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  prueba := 'T5. preview_corte_caja "todas las sedes" (NULL) por recepción → BLOCK';
  resultado := CASE WHEN v_err LIKE 'SUCURSAL_PARAMETRO_INVALIDO%' THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)') END;
  RETURN NEXT;

  v_err := NULL;
  BEGIN PERFORM _guard_sucursal_recepcion(NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  prueba := 'T6. recurso sin sede (NULL) → BLOCK SUCURSAL_RECURSO_DESCONOCIDA';
  resultado := CASE WHEN v_err LIKE 'SUCURSAL_RECURSO_DESCONOCIDA%' THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)') END;
  RETURN NEXT;

  -- ── Recepción SIN sede ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', a_null::text)::text, true);
  v_err := NULL;
  BEGIN PERFORM cancelar_cargo_pendiente(v_cargo_b, 'b9'); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  SELECT estado INTO v_st FROM cargos_pendientes WHERE id = v_cargo_b;
  prueba := 'T7. recepción sin sede asignada → BLOCK SUCURSAL_ACTOR_NO_ASIGNADA, cargo intacto';
  resultado := CASE WHEN v_err LIKE 'SUCURSAL_ACTOR_NO_ASIGNADA%' AND v_st = 'pendiente' THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)')||' estado='||coalesce(v_st,'?') END;
  RETURN NEXT;

  -- ── Admin (regresión): opera cualquier sede ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', a_admin::text)::text, true);
  v_err := NULL;
  BEGIN
    PERFORM cobrar_cargo_pendiente(v_cargo_b, 'efectivo', NULL);
    PERFORM preview_corte_caja(now() - interval '1 day', now(), NULL);
  EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  SELECT estado INTO v_st FROM cargos_pendientes WHERE id = v_cargo_b;
  prueba := 'T8. admin cobra cargo de sede B y ve corte de todas las sedes → ALLOW';
  resultado := CASE WHEN v_err IS NULL AND v_st = 'cobrado' THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'-')||' estado='||coalesce(v_st,'?') END;
  RETURN NEXT;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
  RETURN;
END $$;

SELECT * FROM _diag_branch_isolation();
DROP FUNCTION _diag_branch_isolation();
