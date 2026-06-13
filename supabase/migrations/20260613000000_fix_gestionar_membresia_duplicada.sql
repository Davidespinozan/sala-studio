-- ============================================================================
-- FIX #1 — gestionar_membresia_socio: renovar/cambiar plan desde VENCIDA
--          duplicaba la membresía (INSERT en vez de UPDATE).
-- ----------------------------------------------------------------------------
-- El lookup de "membresía vigente" excluía 'expirada', así que para un socio
-- con plan vencido no encontraba fila → insertaba una segunda membresía. La
-- lógica de renovación YA contemplaba el caso vencida (modo renovacion_desde_hoy
-- + UPDATE), solo faltaba que el lookup la encontrara. Cambio mínimo: sumar
-- 'expirada' al IN. Misma semántica que el ya-incluido 'past_due'.
--
-- Recreamos la función VERBATIM de 20260524500000 con esa única línea cambiada.
-- ============================================================================

CREATE OR REPLACE FUNCTION gestionar_membresia_socio(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_motivo text DEFAULT NULL
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

  -- Membresía anterior (si hay una vigente para el socio)
  v_anterior_id uuid;
  v_anterior_fin timestamptz;
  v_anterior_saldo integer;
  v_anterior_tier_tipo text;
  v_existe_anterior boolean := false;
  v_mismo_tipo boolean := false;

  -- Resultantes
  v_nuevo_fin timestamptz;
  v_nuevo_saldo integer;
  v_modo text;            -- 'alta' | 'renovacion' | 'renovacion_desde_hoy' | 'cambio_de_tipo'
  v_delta_creditos integer;
  v_membresia_id uuid;
  v_motivo_final text;
BEGIN
  -- ── Actor + autorización ───────────────────────────────────────────────
  v_actor_id := get_my_user_id();
  v_actor_tenant_id := get_my_tenant_id();
  IF v_actor_id IS NULL OR v_actor_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff (admin/recepción) puede gestionar membresías';
  END IF;

  -- ── Socio objetivo ─────────────────────────────────────────────────────
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

  -- ── Tier objetivo ──────────────────────────────────────────────────────
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

  -- ── Localizar membresía vigente del socio (lock anti-race) ─────────────
  -- Incluye 'congelada' (reactiva una pausada) y 'expirada' (renovar/cambiar plan
  -- desde VENCIDA reusa la fila en vez de duplicar — fix bug #1 del barrido).
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

  -- ── Calcular nuevo fin y saldo según el caso ───────────────────────────
  IF NOT v_existe_anterior THEN
    -- ALTA nueva (incluye el caso "socio recién creado por admin-create-user
    -- que nunca tuvo membresía")
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
    -- Renovación / recarga (mismo tipo)
    IF v_tier.duracion_dias IS NULL THEN
      -- Tier nuevo es "eterno" (créditos puros sin vencimiento)
      v_nuevo_fin := NULL;
      v_modo := 'renovacion';
    ELSIF v_anterior_fin IS NOT NULL AND v_anterior_fin > v_now THEN
      -- Vigente: suma a partir del fin actual (no pierde días que le quedaban)
      v_nuevo_fin := v_anterior_fin + (v_tier.duracion_dias || ' days')::interval;
      v_modo := 'renovacion';
    ELSE
      -- Vencida (o sin fin previo) y tier nuevo SÍ tiene duración: arranca hoy
      v_nuevo_fin := v_now + (v_tier.duracion_dias || ' days')::interval;
      v_modo := 'renovacion_desde_hoy';
    END IF;

    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE COALESCE(v_anterior_saldo, 0) + COALESCE(v_tier.clases_incluidas, 0)
    END;

  ELSE
    -- Cambio de tipo → reset (créditos viejos se pierden, fechas se recalculan)
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

  -- Delta neto para el ledger (puede ser negativo en cambio_de_tipo si pierde
  -- créditos previos, o cero en altas tipo=tiempo).
  v_delta_creditos := COALESCE(v_nuevo_saldo, 0) - COALESCE(v_anterior_saldo, 0);

  -- ── UPDATE o INSERT de la membresía ────────────────────────────────────
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

  -- ── Ledger ─────────────────────────────────────────────────────────────
  -- Regla general: UN movimiento 'alta' con delta = neto (alta nueva,
  -- renovación, recarga — el delta nunca es negativo en estos casos).
  --
  -- Excepción: si es cambio_de_tipo Y había créditos previos que se pierden,
  -- escribimos DOS movimientos para preservar la semántica real:
  --   1) 'expiracion' delta = -saldo_anterior  (créditos perdidos)
  --   2) 'alta'       delta = nuevo_saldo      (créditos del nuevo paquete)
  -- Así 'alta' nunca queda con delta negativo y el historial cuenta lo que
  -- realmente pasó. Si el socio venía de tipo=tiempo (saldo 0/NULL), no hay
  -- nada que expirar — un solo movimiento 'alta'.
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

  -- ── Sincronizar denormalized caches en usuarios ────────────────────────
  -- Si el socio venía en 'pendiente_pago' (caso típico: recién creado por
  -- admin-create-user), pasarlo a 'activo'. Otros status no se tocan.
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
    'delta_creditos', v_delta_creditos
  );
END;
$$;

REVOKE ALL ON FUNCTION gestionar_membresia_socio(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gestionar_membresia_socio(uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION gestionar_membresia_socio(uuid, uuid, text) IS
  'Fase 4 — alta/renovación manual de la membresía de un socio desde el admin. Solo staff del tenant del socio. Regla suma/reset: mismo tipo SUMA fechas/créditos (renovación o recarga); cambio de tipo RESETEA. Escribe ''alta'' en el ledger con delta neto y created_by=actor. Sincroniza usuarios.membresia_tier y membresia_activa_id (el gate aún los usa). Pasa status=pendiente_pago a activo (caso socio nuevo). Atómica con FOR UPDATE sobre la membresía vigente.';

-- ============================================================================
-- TEST — renovar desde una membresía VENCIDA actualiza la fila (no duplica).
-- Savepoint + centinela; no deja datos. SKIP si no hay recepcionista/tier.
-- ============================================================================
DO $$
DECLARE
  v_recep uuid; v_recep_auth uuid; v_recep_tenant uuid; v_slug text;
  v_tier uuid;
  v_auth_socio uuid := gen_random_uuid();
  v_socio uuid;
  v_pre int; v_post int; v_status text;
BEGIN
  SELECT id, auth_id, tenant_id INTO v_recep, v_recep_auth, v_recep_tenant
  FROM usuarios WHERE rol = 'recepcionista' AND auth_id IS NOT NULL LIMIT 1;
  IF v_recep IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay recepcionista con auth_id (el fix igual quedó aplicado).';
    RETURN;
  END IF;

  SELECT slug INTO v_slug FROM tenants WHERE id = v_recep_tenant;
  SELECT id INTO v_tier FROM tiers WHERE tenant_id = v_recep_tenant AND activo LIMIT 1;
  IF v_tier IS NULL THEN
    RAISE NOTICE 'TEST SKIP: el tenant del recepcionista no tiene tier activo.';
    RETURN;
  END IF;

  BEGIN  -- subtransacción reversible
    -- Socio de prueba (el trigger on_auth_user_created lo crea miembro del tenant).
    INSERT INTO auth.users (instance_id, id, aud, role, email,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES ('00000000-0000-0000-0000-000000000000', v_auth_socio, 'authenticated', 'authenticated',
            'fix-dup-'||substr(v_auth_socio::text,1,8)||'@test.local',
            '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Fix Dup Socio'), now(), now());
    SELECT id INTO v_socio FROM usuarios WHERE auth_id = v_auth_socio;

    -- Membresía VENCIDA (expirada).
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
    VALUES (v_recep_tenant, v_socio, v_tier, 'expirada', now() - interval '60 days', now() - interval '5 days');

    SELECT count(*) INTO v_pre FROM membresias WHERE usuario_id = v_socio;  -- 1

    -- Simular recepcionista (auth.uid resuelve del JWT) y renovar (mismo tier).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_recep_auth::text)::text, true);
    PERFORM gestionar_membresia_socio(v_socio, v_tier, 'Test: renovar desde vencida');

    SELECT count(*) INTO v_post FROM membresias WHERE usuario_id = v_socio;
    SELECT status INTO v_status FROM membresias WHERE usuario_id = v_socio ORDER BY created_at DESC LIMIT 1;

    IF v_post <> v_pre THEN
      RAISE EXCEPTION 'TEST FALLO: renovar desde vencida DUPLICO la membresia (pre=% post=%).', v_pre, v_post;
    END IF;
    IF v_status <> 'activa' THEN
      RAISE EXCEPTION 'TEST FALLO: la membresia no quedo activa (status=%).', v_status;
    END IF;

    RAISE EXCEPTION 'ROLLBACK_FIX_DUP';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_FIX_DUP' THEN NULL;
    ELSE RAISE; END IF;
  END;

  RAISE NOTICE 'TEST OK: renovar desde vencida ACTUALIZA la membresia (no duplica) y queda activa. Revertido.';
END $$;
