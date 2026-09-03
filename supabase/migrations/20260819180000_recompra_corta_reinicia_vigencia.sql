-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Recompra de plan CORTO (créditos/híbrido) REINICIA la vigencia; no la apila
-- ----------------------------------------------------------------------------
-- BUG (caso Daniel, reportado por numa): compró Rise (híbrido, 7 días) el 25 ago y
-- pudo reservar el 2 sep. Causa: antes del Rise le vendieron 5 DAY PASS ($150 c/u,
-- híbrido, 7 días) en la MISMA membresía. Cada compra del mismo tipo, si la anterior
-- aún no vencía, entraba por la rama v_mismo_tipo y hacía `fin = fin_anterior + días`
-- (APILAR). 5 day pass + el upgrade a Rise (day pass y Rise son AMBOS híbrido →
-- mismo_tipo) apilaron 6 × 7 = 42 días → venció 23 sep en vez del 1 sep.
--
-- Esa lógica de "apilar" existe para NO quitarle días pagados a quien renueva su
-- MENSUALIDAD temprano (renovar el día 27 de 30 debe dar día 60, no día 57). Correcto
-- para tiempo; sin sentido para un day pass o un plan corto por clases, donde cada
-- compra debe valer sus propios días desde el día que se compra.
--
-- FIX (único cambio vs 20260819150000): en la rama v_mismo_tipo, APILAR aplica SOLO a
-- `tipo = 'tiempo'` (mensualidad). Créditos/híbrido REINICIAN a `hoy + duracion_dias`.
-- Los créditos se siguen ACUMULANDO en ambos (compraste clases, no las pierdes). Alta
-- y cambio_de_tipo ya reiniciaban (sin cambio). Todo lo demás es idéntico, incluido el
-- fix de inscripción-solo-socio-nuevo. Se reproduce VERBATIM con ese único cambio.
-- ============================================================================

CREATE OR REPLACE FUNCTION gestionar_membresia_socio(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_motivo text DEFAULT NULL,
  p_metodo_pago text DEFAULT NULL,
  p_monto_centavos integer DEFAULT NULL,
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
    ELSIF v_tier.tipo = 'tiempo' AND v_anterior_fin IS NOT NULL AND v_anterior_fin > v_now THEN
      -- SOLO MENSUALIDAD (tiempo): renovar temprano NO debe quitar días pagados → apila.
      v_nuevo_fin := v_anterior_fin + (v_tier.duracion_dias || ' days')::interval;
      v_modo := 'renovacion';
    ELSE
      -- Créditos/híbrido (day pass, Rise) o mensualidad ya vencida: la vigencia arranca
      -- HOY. Antes apilaba también en créditos/híbrido y por eso 5 day pass + un upgrade
      -- inflaban un plan de 7 días a 42. Cada compra corta vale sus propios días.
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

    -- Inscripción: SOLO al socio realmente NUEVO (su primera membresía). Un socio que
    -- YA tuvo un plan antes (aunque haya sido en un periodo con inscripción gratis, o
    -- esté vencido/cancelado) NO paga inscripción al recomprar. 'alta' = no tenía
    -- membresía viva/vencida (renovar/cambiar nunca cobra inscripción); el NOT EXISTS
    -- cubre además a quien su única membresía previa quedó 'cancelada'.
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


-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA.
--   1) MENSUALIDAD renovada temprano → APILA (no pierde días pagados) → ~60 días.
--   2) HÍBRIDO recomprado temprano → REINICIA (no apila) → ~7 días, no 14.
--   3) HÍBRIDO: los créditos SÍ se acumulan igual (7 + 7 = 14).
--   4) La inscripción-solo-socio-nuevo sigue viva (recompra no cobra inscripción).
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_reinicio_vigencia()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_auth uuid := gen_random_uuid(); v_admin uuid;
  v_m uuid; v_h uuid;
  v_mensual uuid; v_hibrido uuid;
  v_slug text := 'zz-test-vig-' || substr(md5(random()::text), 1, 6);
  v_fin_m timestamptz; v_fin_h timestamptz; v_saldo_h int; v_ins_h int;
  v_now timestamptz := now();
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test vigencia', 'gym_libre', 'activo') RETURNING id INTO v_tenant;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data,
                          encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          v_slug || '-admin@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'),
          '', now(), now(), now());
  UPDATE usuarios SET rol = 'admin', status = 'activo' WHERE auth_id = v_auth RETURNING id INTO v_admin;

  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, tipo, clases_incluidas, duracion_dias, inscripcion_centavos, activo, orden)
  VALUES (v_tenant, 'mensual', 'Mensual', 80000, 'MXN', 'mensual', 'tiempo', NULL, 30, 0, true, 1)
  RETURNING id INTO v_mensual;
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, tipo, clases_incluidas, duracion_dias, inscripcion_centavos, activo, orden)
  VALUES (v_tenant, 'hibrido', 'Híbrido 7', 15000, 'MXN', 'mensual', 'hibrido', 7, 7, 30000, true, 2)
  RETURNING id INTO v_hibrido;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-m@x.dev','M','miembro','activo') RETURNING id INTO v_m;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-h@x.dev','H','miembro','activo') RETURNING id INTO v_h;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- MENSUAL: alta + renovar temprano (aún vigente) → debe APILAR (~+60 días).
  PERFORM gestionar_membresia_socio(v_m, v_mensual, 'alta', 'efectivo', 80000);
  PERFORM gestionar_membresia_socio(v_m, v_mensual, 'renovar temprano', 'efectivo', 80000);
  SELECT periodo_actual_fin INTO v_fin_m FROM membresias WHERE usuario_id = v_m;

  -- HÍBRIDO: alta + recompra temprano (aún vigente) → debe REINICIAR (~+7 días) y
  -- ACUMULAR créditos (7+7=14). La recompra NO debe cobrar inscripción.
  PERFORM gestionar_membresia_socio(v_h, v_hibrido, 'alta', 'tarjeta', 15000);
  PERFORM gestionar_membresia_socio(v_h, v_hibrido, 'recompra', 'tarjeta', 15000);
  SELECT periodo_actual_fin, creditos_restantes INTO v_fin_h, v_saldo_h FROM membresias WHERE usuario_id = v_h;
  SELECT count(*) INTO v_ins_h FROM pagos WHERE usuario_id = v_h AND concepto = 'inscripcion';

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);

  prueba := '1. MENSUAL renovada temprano → apila (respeta días pagados)';
  resultado := CASE WHEN v_fin_m > v_now + interval '45 days'
    THEN '✅ apiló (~60 días)' ELSE '❌ no apiló: fin=' || v_fin_m::text END; RETURN NEXT;

  prueba := '2. HÍBRIDO recomprado temprano → reinicia (no apila)';
  resultado := CASE WHEN v_fin_h < v_now + interval '10 days' AND v_fin_h > v_now + interval '5 days'
    THEN '✅ reinició (~7 días, no 14)' ELSE '❌ apiló: fin=' || v_fin_h::text END; RETURN NEXT;

  prueba := '3. HÍBRIDO: créditos se acumulan igual (7+7=14)';
  resultado := CASE WHEN v_saldo_h = 14 THEN '✅ 14 créditos' ELSE '❌ saldo=' || COALESCE(v_saldo_h::text,'NULL') END; RETURN NEXT;

  -- El socio H es NUEVO: su ALTA sí cobra inscripción (correcto). La RECOMPRA no debe
  -- agregar otra. Total esperado = 1 (solo el alta). Si fuera 2, la recompra cobró de más.
  prueba := '4. alta cobra 1 inscripción y la recompra NO agrega otra (total 1)';
  resultado := CASE WHEN v_ins_h = 1 THEN '✅ solo el alta cobró' ELSE '❌ total inscripciones=' || v_ins_h END; RETURN NEXT;
  RETURN;
END $$;

SELECT * FROM _diag_reinicio_vigencia();
DROP FUNCTION _diag_reinicio_vigencia();
