-- ============================================================================
-- FIX M4 — pausar la membresía no pausaba el reloj.
-- ----------------------------------------------------------------------------
-- recepcion_congelar_membresia solo ponía status='congelada' y reactivar lo
-- volvía a 'activa', sin registrar cuándo se congeló ni mover periodo_actual_fin.
-- Una membresía tipo tiempo/híbrido pausada N días seguía venciendo en la misma
-- fecha → el socio perdía los días pausados (el "pausar" no pausaba nada).
--
-- Fix: columna membresias.congelada_at (cuándo se pausó). Al reactivar, se suma
-- (now() - congelada_at) a periodo_actual_fin (si tiene fin; los planes sin
-- vencimiento no se tocan) y se limpia congelada_at.
-- ============================================================================

-- Columna para el momento de congelado (idempotente).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'membresias' AND column_name = 'congelada_at'
  ) THEN
    ALTER TABLE membresias ADD COLUMN congelada_at timestamptz;
    COMMENT ON COLUMN membresias.congelada_at IS
      'Momento en que se pausó la membresía. Al reactivar se extiende periodo_actual_fin por (now()-congelada_at) y se limpia. NULL si no está pausada.';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- recepcion_congelar_membresia — ahora sella congelada_at.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_congelar_membresia(
  p_usuario_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  SELECT m.id, m.status, m.tenant_id, u.nombre
  INTO v_mem
  FROM membresias m
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
$$;

REVOKE ALL ON FUNCTION recepcion_congelar_membresia(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_congelar_membresia(uuid, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- recepcion_reactivar_membresia — extiende el vencimiento por el tiempo pausado.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_reactivar_membresia(
  p_usuario_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
  v_extension interval;
  v_dias numeric;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para reactivar';
  END IF;

  SELECT m.id, m.status, m.tenant_id, m.periodo_actual_fin, m.congelada_at, u.nombre
  INTO v_mem
  FROM membresias m
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
  IF v_mem.status <> 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_ACTIVA: la membresía no estaba pausada';
  END IF;

  -- Tiempo que estuvo pausada (0 si por algún motivo no hay sello).
  v_extension := CASE
    WHEN v_mem.congelada_at IS NOT NULL THEN now() - v_mem.congelada_at
    ELSE interval '0'
  END;
  v_dias := round(extract(epoch FROM v_extension) / 86400.0, 1);

  UPDATE membresias
  SET status = 'activa',
      -- Solo extiende si la membresía vence; los planes sin fin no se tocan.
      periodo_actual_fin = CASE
        WHEN periodo_actual_fin IS NOT NULL THEN periodo_actual_fin + v_extension
        ELSE NULL
      END,
      congelada_at = NULL,
      updated_at = now()
  WHERE id = v_mem.id;

  PERFORM _audrec_log(
    'membresia.reactivar', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Reactivó la membresía (se extendió el vencimiento %s días por la pausa). Motivo: %s', v_dias, p_motivo),
    jsonb_build_object('motivo', p_motivo, 'status_anterior', 'congelada', 'dias_extendidos', v_dias)
  );

  RETURN jsonb_build_object('success', true, 'status', 'activa', 'dias_extendidos', v_dias);
END;
$$;

REVOKE ALL ON FUNCTION recepcion_reactivar_membresia(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_reactivar_membresia(uuid, text) TO authenticated;

-- ============================================================================
-- TEST — pausar y reactivar extiende el vencimiento por el tiempo pausado.
-- Congela, retrocede congelada_at 5 días (simula 5 días pausada) y verifica que
-- periodo_actual_fin se corrió ~5 días. Savepoint + centinela. SKIP sin recep/tier.
-- ============================================================================
DO $$
DECLARE
  v_recep uuid; v_recep_auth uuid; v_recep_tenant uuid; v_slug text;
  v_tier uuid;
  v_auth_socio uuid := gen_random_uuid();
  v_socio uuid;
  v_fin_antes timestamptz; v_fin_despues timestamptz; v_delta interval;
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

  BEGIN
    INSERT INTO auth.users (instance_id, id, aud, role, email,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES ('00000000-0000-0000-0000-000000000000', v_auth_socio, 'authenticated', 'authenticated',
            'fix-cong-'||substr(v_auth_socio::text,1,8)||'@test.local',
            '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Fix Congelar'), now(), now());
    SELECT id INTO v_socio FROM usuarios WHERE auth_id = v_auth_socio;

    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
    VALUES (v_recep_tenant, v_socio, v_tier, 'activa', now() - interval '5 days', now() + interval '20 days');

    SELECT periodo_actual_fin INTO v_fin_antes FROM membresias WHERE usuario_id = v_socio;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_recep_auth::text)::text, true);
    PERFORM recepcion_congelar_membresia(v_socio, 'Test: pausa');

    -- Simular que estuvo 5 días pausada.
    UPDATE membresias SET congelada_at = now() - interval '5 days' WHERE usuario_id = v_socio;

    PERFORM recepcion_reactivar_membresia(v_socio, 'Test: reactivar');

    SELECT periodo_actual_fin INTO v_fin_despues FROM membresias WHERE usuario_id = v_socio;
    v_delta := v_fin_despues - v_fin_antes;

    IF v_delta < interval '5 days' - interval '10 seconds'
       OR v_delta > interval '5 days' + interval '10 seconds' THEN
      RAISE EXCEPTION 'TEST FALLO: el vencimiento se extendió % (esperaba ~5 días).', v_delta;
    END IF;

    RAISE EXCEPTION 'ROLLBACK_FIX_CONG';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_FIX_CONG' THEN NULL;
    ELSE RAISE; END IF;
  END;

  RAISE NOTICE 'TEST OK: reactivar extiende periodo_actual_fin por el tiempo pausado (~5 días). Revertido.';
END $$;
