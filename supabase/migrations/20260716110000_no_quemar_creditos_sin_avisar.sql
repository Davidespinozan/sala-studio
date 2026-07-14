-- ============================================================================
-- Cambiar de plan le quemaba al socio las clases que había pagado
-- ----------------------------------------------------------------------------
-- Un socio con 8 clases sin usar de su paquete compra una mensualidad. Las 8 se
-- borran. Sin confirmación, sin aviso, sin vuelta atrás: la recepcionista aprieta
-- un botón y desaparece dinero del socio.
--
-- ¿Por qué se pierden? Porque un socio tiene UNA membresía. Si su plan pasa a ser
-- de tipo 'tiempo', las clases sueltas no tienen dónde vivir — la fila es una
-- sola. Conservarlas de verdad exige poder tener dos membresías a la vez
-- (mensualidad + paquete), que es un cambio estructural, no un parche.
--
-- Lo que SÍ se puede hoy, y es lo que faltaba: que nadie las queme sin saberlo.
-- Que se pierdan puede ser una decisión legítima del gym —el socio hace upgrade y
-- el gym le perdona el saldo—, pero tiene que ser una DECISIÓN, no un accidente.
--
-- Ahora la función se NIEGA a quemar clases salvo que quien la llama lo confirme
-- explícitamente. El guard vive en la BASE, no en la pantalla: hoy el admin sí
-- avisaba ("el socio pierde N clases") pero recepción no decía nada, y una regla
-- que solo vive en una de las dos pantallas no es una regla.
-- ============================================================================

-- ── 1) El motor: gestionar_membresia_socio ──────────────────────────────────
CREATE OR REPLACE FUNCTION gestionar_membresia_socio(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_motivo text DEFAULT NULL,
  -- Cobro real. NULL → no se registra dinero (cortesía, o ya pagó por Stripe).
  p_metodo_pago text DEFAULT NULL,
  -- Monto efectivamente cobrado. NULL → el precio de lista del plan.
  p_monto_centavos integer DEFAULT NULL,
  -- Cambiar de paquete a mensualidad (o al revés) QUEMA las clases sin usar: el
  -- socio tiene UNA membresía, y las clases sueltas no tienen dónde vivir. Que se
  -- pierdan puede estar bien —lo decide el gym—, pero no puede pasar sin que
  -- alguien lo haya visto. Sin este flag, la función se niega.
  p_confirmar_perdida boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_existe_anterior boolean := false;
  v_mismo_tipo boolean := false;

  v_nuevo_fin timestamptz;
  v_nuevo_saldo integer;
  v_modo text;
  v_delta_creditos integer;
  v_membresia_id uuid;
  v_motivo_final text;

  -- Dinero
  v_monto_plan integer;
  v_cobra_inscripcion boolean := false;
  v_inscripcion integer := 0;
  v_sucursal_id uuid;  -- la sede vive en la membresía, no en usuarios
BEGIN
  v_actor_id := get_my_user_id();
  v_actor_tenant_id := get_my_tenant_id();
  IF v_actor_id IS NULL OR v_actor_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff (admin/recepción) puede gestionar membresías';
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

  SELECT m.id, m.periodo_actual_fin, m.creditos_restantes, t.tipo
  INTO v_anterior_id, v_anterior_fin, v_anterior_saldo, v_anterior_tier_tipo
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada', 'expirada')
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  v_existe_anterior := v_anterior_id IS NOT NULL;
  v_mismo_tipo := v_existe_anterior AND v_anterior_tier_tipo = v_tier.tipo;

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
    ELSIF v_anterior_fin IS NOT NULL AND v_anterior_fin > v_now THEN
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

  -- EL GUARD DEL DINERO DEL SOCIO. Antes esto pasaba callado: la recepcionista
  -- apretaba un botón y las clases que el socio había pagado desaparecían, sin
  -- confirmación, sin aviso y sin vuelta atrás.
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
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'expiracion', -v_anterior_saldo,
      NULL,
      format('créditos perdidos por cambio de plan (tier %s)', v_tier.slug),
      v_actor_id
    );

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'alta', COALESCE(v_nuevo_saldo, 0),
      NULL, v_motivo_final, v_actor_id
    );
  ELSE
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'alta', v_delta_creditos,
      NULL, v_motivo_final, v_actor_id
    );
  END IF;

  -- ── DINERO (nuevo) ────────────────────────────────────────────────────────
  -- Sin método → no se registra cobro (asignación de cortesía o ya pagada online).
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

    -- Inscripción: UNA sola vez por socio, en su primer plan.
    v_inscripcion := COALESCE(v_tier.inscripcion_centavos, 0);
    v_cobra_inscripcion := v_inscripcion > 0 AND v_socio.inscripcion_pagada_at IS NULL;

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
      status = CASE
        WHEN status = 'pendiente_pago' THEN 'activo'
        ELSE status
      END
  WHERE id = p_usuario_id;

  RETURN jsonb_build_object(
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
END;
$$;

REVOKE ALL ON FUNCTION gestionar_membresia_socio(uuid, uuid, text, text, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION gestionar_membresia_socio(uuid, uuid, text, text, integer, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION gestionar_membresia_socio(uuid, uuid, text, text, integer, boolean) TO authenticated;

-- La firma vieja (5 args) queda muerta: si sobrevive, un llamador viejo podría
-- seguir quemando clases sin confirmar. Se borra.
DROP FUNCTION IF EXISTS gestionar_membresia_socio(uuid, uuid, text, text, integer);


-- ── 2) Recepción: pasa la confirmación al motor ─────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_cambiar_plan(
  p_usuario_id uuid,
  p_nuevo_tier_id uuid,
  p_motivo text,
  p_metodo_pago text DEFAULT NULL,
  p_monto_centavos integer DEFAULT NULL,
  -- Ver gestionar_membresia_socio: sin esto, un cambio que quema clases se niega.
  p_confirmar_perdida boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membresia_actual RECORD;
  v_tier_anterior_id uuid;
  v_socio_nombre text;
  v_resultado jsonb;
BEGIN
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para cambiar de plan';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM tiers WHERE id = p_nuevo_tier_id) THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE: el nuevo plan no existe';
  END IF;

  SELECT m.id, m.tier_id, u.nombre
  INTO v_membresia_actual
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_membresia_actual.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía previa para cambiar';
  END IF;

  v_tier_anterior_id := v_membresia_actual.tier_id;
  v_socio_nombre := v_membresia_actual.nombre;

  IF v_tier_anterior_id = p_nuevo_tier_id THEN
    RAISE EXCEPTION 'TIER_IGUAL: el nuevo plan es igual al actual. Usá renovar en su lugar';
  END IF;

  SELECT gestionar_membresia_socio(
    p_usuario_id, p_nuevo_tier_id, p_motivo, p_metodo_pago, p_monto_centavos,
    p_confirmar_perdida
  )
  INTO v_resultado;

  PERFORM _audrec_log(
    'membresia.cambiar_plan',
    'membresia',
    v_membresia_actual.id,
    p_usuario_id,
    v_socio_nombre,
    format('Cambió de plan. Motivo: %s', p_motivo),
    jsonb_build_object(
      'tier_anterior_id', v_tier_anterior_id,
      'tier_nuevo_id', p_nuevo_tier_id,
      'motivo', p_motivo,
      'metodo_pago', p_metodo_pago,
      'resultado', v_resultado
    )
  );

  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_cambiar_plan(uuid, uuid, text, text, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION recepcion_cambiar_plan(uuid, uuid, text, text, integer, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION recepcion_cambiar_plan(uuid, uuid, text, text, integer, boolean) TO authenticated;

DROP FUNCTION IF EXISTS recepcion_cambiar_plan(uuid, uuid, text, text, integer);


-- ============================================================================
-- SELF-TEST — con las clases de un socio no alcanza con "compila".
-- ============================================================================
DO $$
DECLARE
  v_tenant uuid;
  v_admin uuid;
  v_socio uuid;
  v_auth uuid := gen_random_uuid();
  v_paquete uuid;
  v_mensual uuid;
  v_slug text := 'zz-test-cred-' || substr(md5(random()::text), 1, 6);
  v_err text;
  v_saldo integer;
  v_quemado integer;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test créditos', 'gym_libre', 'activo')
  RETURNING id INTO v_tenant;

  -- El admin (el trigger de signup crea su fila de usuarios; lo promovemos).
  INSERT INTO auth.users (
    id, instance_id, aud, role, email, raw_user_meta_data,
    encrypted_password, email_confirmed_at, created_at, updated_at
  ) VALUES (
    v_auth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    v_slug || '-admin@sala.dev',
    jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'),
    '', now(), now(), now()
  );
  UPDATE usuarios SET rol = 'admin', status = 'activo'
  WHERE auth_id = v_auth RETURNING id INTO v_admin;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug || '-socio@sala.dev', 'Socio', 'miembro', 'activo')
  RETURNING id INTO v_socio;

  -- Un paquete de 10 clases y una mensualidad.
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, tipo, clases_incluidas, duracion_dias, activo, orden)
  VALUES (v_tenant, 'paq10', 'Paquete 10', 100000, 'MXN', 'mensual', 'creditos', 10, 60, true, 1)
  RETURNING id INTO v_paquete;

  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, tipo, clases_incluidas, duracion_dias, activo, orden)
  VALUES (v_tenant, 'mensual', 'Mensual', 80000, 'MXN', 'mensual', 'tiempo', NULL, 30, true, 2)
  RETURNING id INTO v_mensual;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_auth::text)::text, true);

  -- El socio compra el paquete: 10 clases.
  PERFORM gestionar_membresia_socio(v_socio, v_paquete, 'compra de paquete', 'efectivo', 100000);

  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE usuario_id = v_socio;
  IF v_saldo <> 10 THEN
    RAISE EXCEPTION 'FALLA: el paquete debería dejar 10 clases, dejó %', v_saldo;
  END IF;

  -- Usa 2: le quedan 8 sin usar.
  UPDATE membresias SET creditos_restantes = 8 WHERE usuario_id = v_socio;

  -- 1) LA PRUEBA QUE IMPORTA: pasar a mensualidad SIN confirmar se NIEGA.
  BEGIN
    PERFORM gestionar_membresia_socio(v_socio, v_mensual, 'upgrade', 'efectivo', 80000);
    RAISE EXCEPTION 'FALLA: quemó 8 clases del socio sin que nadie lo confirmara';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'CREDITOS_SE_PIERDEN%' THEN RAISE; END IF;
  END;

  -- 2) Y las clases siguen ahí: el intento fallido no tocó nada.
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE usuario_id = v_socio;
  IF v_saldo <> 8 THEN
    RAISE EXCEPTION 'FALLA: el intento rechazado igual tocó el saldo (quedó %)', v_saldo;
  END IF;

  -- 3) Con confirmación explícita, sí procede (el gym decidió perdonarle el saldo).
  PERFORM gestionar_membresia_socio(v_socio, v_mensual, 'upgrade', 'efectivo', 80000, true);

  -- 4) Y la pérdida queda ASENTADA en el ledger: el socio puede reclamar.
  SELECT COALESCE(SUM(-delta_creditos), 0) INTO v_quemado
  FROM membresia_movimientos
  WHERE tenant_id = v_tenant AND tipo = 'expiracion';

  IF v_quemado <> 8 THEN
    RAISE EXCEPTION 'FALLA: el ledger debería registrar 8 clases perdidas, registró %', v_quemado;
  END IF;

  -- 5) Renovar el MISMO tipo de plan nunca quema nada (no pide confirmación).
  PERFORM gestionar_membresia_socio(v_socio, v_mensual, 'renovación', 'efectivo', 80000);

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
END;
$$;

SELECT 'cambiar de tipo con clases sin usar se NIEGA sin confirmación' AS prueba,
       'CREDITOS_SE_PIERDEN' AS espera, 'OK' AS resultado
UNION ALL
SELECT 'el intento rechazado no toca el saldo del socio', 'saldo intacto', 'OK'
UNION ALL
SELECT 'con confirmación procede y la pérdida queda en el ledger', 'auditable', 'OK'
UNION ALL
SELECT 'renovar el mismo plan nunca pide confirmación', 'sin fricción', 'OK'
UNION ALL
SELECT 'la firma vieja (sin confirmación) ya no existe',
       '0 funciones de 5 args',
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FALLA: sobrevive un camino que quema sin avisar' END
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'gestionar_membresia_socio'
  AND pg_get_function_identity_arguments(p.oid) = 'uuid, uuid, text, text, integer';
