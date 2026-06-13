-- ============================================================================
-- HARDENING membresías — #2 (validación tiers) + #4 (reactivar revalida
-- vencimiento) + #5 (invariante congelada_at).
-- ============================================================================
-- #2 · tiers no validaba clases_incluidas ni precio: un tier creditos/hibrido
--      con clases_incluidas NULL/0 da de alta una membresía con saldo 0 (socio
--      bloqueado desde el alta); precio_centavos admitía negativos.
-- #4 · recepcion_reactivar_membresia ponía status='activa' sin re-chequear el
--      vencimiento: una membresía congelada ya vencida (o sin sello congelada_at)
--      quedaba 'activa' con periodo_actual_fin en el pasado → estado inconsistente
--      que la ficha muestra como activa aunque el gate la trate como vencida.
-- #5 · gestionar_membresia_socio reactivaba una congelada (status='activa') sin
--      limpiar congelada_at → quedaba un sello stale en una membresía activa.
--      Lo resolvemos con un invariante: congelada_at solo existe si status=
--      'congelada' (trigger), sin recrear la función grande.
-- ============================================================================

-- ── #2: validación de tiers (NOT VALID + VALIDATE condicional) ──────────────
-- NOT VALID igual ENFORCA en INSERT/UPDATE nuevos; solo no revalida lo viejo.
-- Validamos lo existente únicamente si está limpio; si no, avisamos sin abortar.
ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_precio_no_neg;
ALTER TABLE tiers ADD CONSTRAINT tiers_precio_no_neg
  CHECK (precio_centavos >= 0) NOT VALID;

ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_clases_paquete;
ALTER TABLE tiers ADD CONSTRAINT tiers_clases_paquete
  CHECK (tipo = 'tiempo' OR (clases_incluidas IS NOT NULL AND clases_incluidas > 0)) NOT VALID;

DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM tiers WHERE precio_centavos < 0;
  IF v_bad = 0 THEN
    ALTER TABLE tiers VALIDATE CONSTRAINT tiers_precio_no_neg;
  ELSE
    RAISE NOTICE 'tiers_precio_no_neg: % fila(s) con precio negativo → constraint queda NOT VALID (protege writes nuevos). Limpiá esas filas y corré VALIDATE.', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM tiers
    WHERE tipo <> 'tiempo' AND (clases_incluidas IS NULL OR clases_incluidas <= 0);
  IF v_bad = 0 THEN
    ALTER TABLE tiers VALIDATE CONSTRAINT tiers_clases_paquete;
  ELSE
    RAISE NOTICE 'tiers_clases_paquete: % tier(s) paquete sin clases_incluidas>0 → constraint NOT VALID. Corregí y corré VALIDATE.', v_bad;
  END IF;
END $$;

-- ── #5: invariante congelada_at (solo válido mientras status='congelada') ───
CREATE OR REPLACE FUNCTION trg_membresia_congelada_at_invariante()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Cualquier transición que deje la membresía NO congelada borra el sello de
  -- pausa (gestionar_membresia_socio lo dejaba stale al reactivar; acá se
  -- garantiza de forma sistémica para todos los caminos).
  IF NEW.status IS DISTINCT FROM 'congelada' AND NEW.congelada_at IS NOT NULL THEN
    NEW.congelada_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_membresia_congelada_at_invariante() IS
  'Invariante: membresias.congelada_at solo es no-NULL mientras status=congelada. Limpia sellos stale en cualquier transición (fix #5).';

DROP TRIGGER IF EXISTS membresias_congelada_at_invariante ON membresias;
CREATE TRIGGER membresias_congelada_at_invariante
  BEFORE INSERT OR UPDATE ON membresias
  FOR EACH ROW
  EXECUTE FUNCTION trg_membresia_congelada_at_invariante();

-- ── #4: recepcion_reactivar_membresia — revalida vencimiento al reactivar ───
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
  v_nuevo_fin timestamptz;
  v_status_final text;
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

  -- Nuevo vencimiento (planes sin fin no se tocan).
  v_nuevo_fin := CASE
    WHEN v_mem.periodo_actual_fin IS NOT NULL THEN v_mem.periodo_actual_fin + v_extension
    ELSE NULL
  END;
  -- Si tras extender sigue vencida (p.ej. se congeló ya vencida, o sin sello),
  -- NO la dejamos 'activa' mintiendo: queda 'expirada'.
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
$$;

REVOKE ALL ON FUNCTION recepcion_reactivar_membresia(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_reactivar_membresia(uuid, text) TO authenticated;

-- ============================================================================
-- TESTS — #4 (reactivar revalida) y #5 (invariante congelada_at). Reversibles.
-- ============================================================================
DO $$
DECLARE
  v_recep uuid; v_recep_auth uuid; v_tenant uuid; v_tier uuid;
  v_auth_v uuid := gen_random_uuid(); v_socio_v uuid; v_mem_v uuid;
  v_auth_ok uuid := gen_random_uuid(); v_socio_ok uuid; v_mem_ok uuid;
  v_status text; v_congelada_at timestamptz;
BEGIN
  SELECT id, auth_id, tenant_id INTO v_recep, v_recep_auth, v_tenant
  FROM usuarios WHERE rol = 'recepcionista' AND auth_id IS NOT NULL LIMIT 1;
  IF v_recep IS NULL THEN RAISE NOTICE 'TEST SKIP: no hay recepcionista con auth_id.'; RETURN; END IF;
  SELECT id INTO v_tier FROM tiers WHERE tenant_id = v_tenant AND activo LIMIT 1;
  IF v_tier IS NULL THEN RAISE NOTICE 'TEST SKIP: no hay tier activo.'; RETURN; END IF;

  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_recep_auth::text)::text, true);

    -- ── Socio "vencido": membresía congelada con fin en el pasado y sello ahora
    --    (extensión ~0) → reactivar debe dejarla EXPIRADA, no activa. ──
    INSERT INTO auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES ('00000000-0000-0000-0000-000000000000', v_auth_v, 'authenticated', 'authenticated',
            'reac-v-'||substr(v_auth_v::text,1,8)||'@test.local', '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('tenant_slug', (SELECT slug FROM tenants WHERE id = v_tenant), 'nombre', 'Reac Vencido'), now(), now());
    SELECT id INTO v_socio_v FROM usuarios WHERE auth_id = v_auth_v;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, congelada_at)
    VALUES (v_tenant, v_socio_v, v_tier, 'congelada', now() - interval '40 days', now() - interval '5 days', now())
    RETURNING id INTO v_mem_v;

    PERFORM recepcion_reactivar_membresia(v_socio_v, 'Test: reactivar vencida');
    SELECT status INTO v_status FROM membresias WHERE id = v_mem_v;
    IF v_status <> 'expirada' THEN
      RAISE EXCEPTION 'TEST #4 FALLO: reactivar una congelada vencida quedó "%" (esperado expirada).', v_status;
    END IF;

    -- ── Socio "ok": congelada con fin futuro → reactivar debe quedar ACTIVA ──
    INSERT INTO auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES ('00000000-0000-0000-0000-000000000000', v_auth_ok, 'authenticated', 'authenticated',
            'reac-ok-'||substr(v_auth_ok::text,1,8)||'@test.local', '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('tenant_slug', (SELECT slug FROM tenants WHERE id = v_tenant), 'nombre', 'Reac OK'), now(), now());
    SELECT id INTO v_socio_ok FROM usuarios WHERE auth_id = v_auth_ok;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, congelada_at)
    VALUES (v_tenant, v_socio_ok, v_tier, 'congelada', now() - interval '10 days', now() + interval '20 days', now() - interval '3 days')
    RETURNING id INTO v_mem_ok;

    PERFORM recepcion_reactivar_membresia(v_socio_ok, 'Test: reactivar vigente');
    SELECT status, congelada_at INTO v_status, v_congelada_at FROM membresias WHERE id = v_mem_ok;
    IF v_status <> 'activa' THEN
      RAISE EXCEPTION 'TEST #4 FALLO: reactivar una congelada vigente quedó "%" (esperado activa).', v_status;
    END IF;
    -- #5: tras reactivar, congelada_at debe estar limpio.
    IF v_congelada_at IS NOT NULL THEN
      RAISE EXCEPTION 'TEST #5 FALLO: congelada_at quedó con sello tras reactivar (%).', v_congelada_at;
    END IF;

    -- ── #5 directo: un UPDATE crudo que saca de 'congelada' limpia el sello ──
    UPDATE membresias SET status = 'congelada', congelada_at = now() WHERE id = v_mem_ok;
    UPDATE membresias SET status = 'activa' WHERE id = v_mem_ok;  -- sin tocar congelada_at
    SELECT congelada_at INTO v_congelada_at FROM membresias WHERE id = v_mem_ok;
    IF v_congelada_at IS NOT NULL THEN
      RAISE EXCEPTION 'TEST #5 FALLO: el invariante no limpió congelada_at al salir de congelada.';
    END IF;

    RAISE EXCEPTION 'ROLLBACK_HARDENING';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_HARDENING' THEN
      RAISE NOTICE 'TESTS OK: #4 reactivar revalida vencimiento (vencida→expirada, vigente→activa); #5 congelada_at se limpia al salir de congelada. Revertido.';
    ELSE RAISE; END IF;
  END;
END $$;
