-- ============================================================================
-- WAVE 4-B (pieza 1) — Ajuste manual de créditos canónico (D2)
-- ----------------------------------------------------------------------------
-- D2 (owner): permitir ajustes + y − de créditos por personal autorizado, SOLO
-- por una operación canónica con autorización + motivo + actor + timestamp +
-- op_key/idempotencia + asiento durable + atomicidad, y nunca saldo negativo.
--
-- Esta pieza:
--   1) recepcion_recargar_creditos: se enruta por _aplicar_credito (misma firma,
--      mismo comportamiento add-only; ahora el saldo y el asiento salen del helper
--      canónico = atómico + veto de negativo). Compat total con el frontend actual.
--   2) recepcion_ajustar_creditos (NUEVO): ajuste + o − con op_key (W1), motivo
--      obligatorio, autorización staff, vía _aplicar_credito (veto de negativo).
--
-- Usa el helper _aplicar_credito de W4-A. NO toca los RPC de reserva/membresía
-- (esos son la pieza B4, que depende del mecanismo de A5). NO instala A5.
-- Aditiva; BEGIN/COMMIT con self-tests que DEVUELVEN TABLA.
-- ============================================================================

BEGIN;

-- ── 0) Registrar la acción nueva en la lista blanca de la bitácora ───────────
-- auditoria_recepcion.accion es una lista CERRADA (CHECK). recepcion_ajustar_creditos
-- usa 'membresia.ajustar_creditos', que aún no está. Se agrega DINÁMICAMENTE leyendo
-- la definición viva y anteponiendo el valor → preserva TODOS los valores actuales
-- (incluidos los que agregaron migraciones posteriores, p.ej. 'checkin.huella'),
-- sin hardcodear la lista (que podría estar desactualizada).
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint WHERE conname = 'auditoria_recepcion_accion_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'No existe auditoria_recepcion_accion_check';
  END IF;
  IF position('membresia.ajustar_creditos' IN v_def) = 0 THEN
    IF position('ARRAY[' IN v_def) > 0 THEN
      v_def := replace(v_def, 'ARRAY[', 'ARRAY[''membresia.ajustar_creditos''::text, ');
    ELSIF position(' IN (' IN v_def) > 0 THEN
      v_def := replace(v_def, ' IN (', ' IN (''membresia.ajustar_creditos'', ');
    ELSE
      RAISE EXCEPTION 'formato inesperado del CHECK de accion: %', v_def;
    END IF;
    EXECUTE 'ALTER TABLE auditoria_recepcion DROP CONSTRAINT auditoria_recepcion_accion_check';
    EXECUTE 'ALTER TABLE auditoria_recepcion ADD CONSTRAINT auditoria_recepcion_accion_check ' || v_def;
  END IF;
END $$;

-- ── 1) recepcion_recargar_creditos — enrutada por el helper (add-only, misma firma)
CREATE OR REPLACE FUNCTION recepcion_recargar_creditos(
  p_usuario_id uuid,
  p_cantidad integer,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  SELECT m.id, m.status, m.tenant_id, m.creditos_restantes, t.tipo, u.nombre
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
$$;

REVOKE ALL ON FUNCTION recepcion_recargar_creditos(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_recargar_creditos(uuid, integer, text) TO authenticated;


-- ── 2) recepcion_ajustar_creditos — NUEVO: ajuste + o − canónico con op_key (D2)
CREATE OR REPLACE FUNCTION recepcion_ajustar_creditos(
  p_usuario_id uuid,
  p_delta integer,
  p_motivo text,
  p_operation_key uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  SELECT m.id, m.status, m.tenant_id, m.creditos_restantes, t.tipo, u.nombre
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
$$;

REVOKE ALL ON FUNCTION recepcion_ajustar_creditos(uuid, integer, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION recepcion_ajustar_creditos(uuid, integer, text, uuid) TO authenticated;

COMMENT ON FUNCTION recepcion_ajustar_creditos(uuid, integer, text, uuid) IS
  'W4-B. Ajuste manual canónico de créditos (+/−) por staff: autorización + motivo '
  'obligatorio + op_key idempotente (W1) + asiento vía _aplicar_credito (veto de '
  'saldo negativo). Reemplaza el UPDATE directo off-ledger para reducir créditos.';


-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — tenant desechable + recep con auth + jwt.
-- cerrar_tenant limpia al final. RAISE en cualquier fallo revierte TODO.
-- ============================================================================
CREATE TEMP TABLE _w4b1_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $$
DECLARE
  v_slug text := 'zz-w4b1-' || substr(md5(random()::text), 1, 6);
  v_tenant uuid;
  v_auth uuid := gen_random_uuid();
  v_recep uuid;
  v_socio uuid;
  v_tier uuid;
  v_mem uuid;
  v_r jsonb;
  v_saldo integer;
  v_ok boolean;
  v_key uuid := gen_random_uuid();
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'W4B1', 'gym_libre', 'activo') RETURNING id INTO v_tenant;

  -- Recepcionista con auth (para que is_recepcionista()/get_my_* funcionen bajo jwt).
  -- Insertar en auth.users dispara handle_new_auth_user, que CREA la ficha usuarios
  -- (rol miembro/pendiente_onboarding) vía el tenant_slug del metadata. No la
  -- insertamos a mano (chocaría con el UNIQUE tenant_id+email); solo la promovemos.
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',v_slug||'-r@sala.dev',
          jsonb_build_object('tenant_slug',v_slug,'nombre','Recep'),'',now(),now(),now());
  UPDATE usuarios SET rol='recepcionista', status='activo' WHERE auth_id = v_auth RETURNING id INTO v_recep;
  IF v_recep IS NULL THEN RAISE EXCEPTION 'SETUP FALLO: el trigger no creó la ficha del recepcionista'; END IF;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug||'-s@sala.dev', 'Socio', 'miembro', 'activo') RETURNING id INTO v_socio;

  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, clases_incluidas)
  VALUES (v_tenant, 'w4b1-cred', 'W4B1 Créditos', 100000, 'creditos', 10) RETURNING id INTO v_tier;

  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, creditos_restantes)
  VALUES (v_tenant, v_socio, v_tier, 'activa', 3) RETURNING id INTO v_mem;

  -- Actuar como el recepcionista.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- T1: recargar (add-only) enruta por el helper y deja asiento.
  v_r := recepcion_recargar_creditos(v_socio, 2, 'test recarga');
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  IF v_saldo <> 5 THEN RAISE EXCEPTION 'T1 FALLO: saldo esperado 5, got %', v_saldo; END IF;
  IF NOT EXISTS (SELECT 1 FROM membresia_movimientos WHERE membresia_id=v_mem AND tipo='ajuste' AND delta_creditos=2) THEN
    RAISE EXCEPTION 'T1 FALLO: no quedó asiento de la recarga';
  END IF;
  INSERT INTO _w4b1_res VALUES (1, 'recargar_creditos enruta por helper (+2 => 5, con asiento)', 'OK');

  -- T2: ajustar negativo válido.
  v_r := recepcion_ajustar_creditos(v_socio, -2, 'test quita', NULL);
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  IF v_saldo <> 3 THEN RAISE EXCEPTION 'T2 FALLO: saldo esperado 3, got %', v_saldo; END IF;
  INSERT INTO _w4b1_res VALUES (2, 'ajustar_creditos −2 (=> 3) con asiento', 'OK');

  -- T3: ajuste que dejaría negativo → bloqueado.
  v_ok := false;
  BEGIN
    PERFORM recepcion_ajustar_creditos(v_socio, -99, 'sobregiro', NULL);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SALDO_NEGATIVO%' THEN v_ok := true; END IF;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T3 FALLO: se permitió dejar saldo negativo'; END IF;
  INSERT INTO _w4b1_res VALUES (3, 'ajuste a negativo bloqueado (SALDO_NEGATIVO)', 'OK');

  -- T4: motivo obligatorio.
  v_ok := false;
  BEGIN
    PERFORM recepcion_ajustar_creditos(v_socio, 1, '', NULL);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'MOTIVO_REQUERIDO%' THEN v_ok := true; END IF;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T4 FALLO: se aceptó ajuste sin motivo'; END IF;
  INSERT INTO _w4b1_res VALUES (4, 'motivo obligatorio (MOTIVO_REQUERIDO)', 'OK');

  -- T5: idempotencia — misma op_key dos veces = un solo efecto.
  v_r := recepcion_ajustar_creditos(v_socio, 4, 'bono', v_key);
  IF (v_r->>'status') <> 'ok' THEN RAISE EXCEPTION 'T5 FALLO: primer llamado no fue ok (%)', v_r->>'status'; END IF;
  v_r := recepcion_ajustar_creditos(v_socio, 4, 'bono', v_key);
  IF (v_r->>'status') <> 'already_processed' THEN RAISE EXCEPTION 'T5 FALLO: replay no convergió (%)', v_r->>'status'; END IF;
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  IF v_saldo <> 7 THEN RAISE EXCEPTION 'T5 FALLO: replay dobló el crédito (saldo=%, esperado 7)', v_saldo; END IF;
  INSERT INTO _w4b1_res VALUES (5, 'idempotencia op_key: replay no dobla (=> 7, un solo asiento)', 'OK');

  -- limpiar contexto jwt antes de cerrar (cerrar_tenant corre como postgres en la migración)
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM cerrar_tenant(v_slug);
END $$;

SELECT orden, prueba, resultado FROM _w4b1_res ORDER BY orden;

COMMIT;
