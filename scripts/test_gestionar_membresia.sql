-- ============================================================================
-- TESTS — gestionar_membresia_socio (Fase 4: alta/renovación manual)
-- ============================================================================
-- USO: pegar este bloque entero en el SQL Editor de Supabase y ejecutar.
--      BEGIN/ROLLBACK → NO persiste ningún cambio. El veredicto sale como
--      TABLA al final (pestaña Results).
--
-- ESTRATEGIA — igual que test_membresias_gate.sql / test_membresias_cancelacion.sql:
-- snapshots de baseline al inicio + helper _reset() entre tests. NO savepoints.
--
-- ACTOR — usamos a David (davidespinunez@gmail.com) impersonando como admin.
--   Su rol natural es 'miembro'; cada test que requiere "actor admin" lo
--   muta a 'admin' después del reset. El test "solo staff puede" deja a
--   David en su rol natural ('miembro') para verificar el rechazo.
-- SOCIO OBJETIVO — un mock @example.com (víctima del admin). Sin auth_id,
--   no se impersona — solo recibe los cambios del RPC.
-- TIERS — usamos dos del tenant: el del mock (tier_a) y otro distinto
--   (tier_b) para los casos de cambio_de_tipo.
-- ============================================================================

BEGIN;

-- ── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pg_temp._as(p_auth_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_auth_id IS NULL THEN
    PERFORM set_config('request.jwt.claims', '', true);
  ELSE
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', p_auth_id::text)::text,
      true
    );
  END IF;
END $$;

-- ── tablas de soporte ──────────────────────────────────────────────────────

CREATE TEMP TABLE _tst_results (
  n integer PRIMARY KEY,
  test text NOT NULL,
  ok boolean NOT NULL,
  detalle text
);

CREATE TEMP TABLE _tst_ctx (
  actor_id uuid,           -- David
  actor_auth_id uuid,      -- auth_id de David
  mock_id uuid,            -- socio mock (víctima del admin)
  tier_a_id uuid,          -- tier inicial del mock
  tier_b_id uuid,          -- otro tier del tenant (para cambio_de_tipo)
  tenant_id uuid
);

-- ── setup ──────────────────────────────────────────────────────────────────

DO $ctx$
DECLARE
  v_actor_id uuid;
  v_actor_auth_id uuid;
  v_mock_id uuid;
  v_tenant uuid;
  v_tier_a uuid;
  v_tier_b uuid;
BEGIN
  SELECT id, auth_id, tenant_id
    INTO v_actor_id, v_actor_auth_id, v_tenant
    FROM usuarios
    WHERE email = 'davidespinunez@gmail.com';

  IF v_actor_id IS NULL OR v_actor_auth_id IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: David sin id/auth_id';
  END IF;

  -- Mock: cualquier socio @example.com del mismo tenant con membresía activa
  SELECT u.id INTO v_mock_id
  FROM usuarios u
  JOIN membresias m ON m.usuario_id = u.id AND m.status = 'activa'
  WHERE u.tenant_id = v_tenant
    AND u.rol = 'miembro'
    AND u.email LIKE '%@example.com'
  LIMIT 1;

  IF v_mock_id IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: no se encontró mock con membresía activa';
  END IF;

  -- Dos tiers distintos del tenant (activos)
  SELECT id INTO v_tier_a FROM tiers
   WHERE tenant_id = v_tenant AND activo = true
   ORDER BY orden LIMIT 1;

  SELECT id INTO v_tier_b FROM tiers
   WHERE tenant_id = v_tenant AND activo = true AND id <> v_tier_a
   ORDER BY orden LIMIT 1;

  IF v_tier_a IS NULL OR v_tier_b IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: se necesitan 2 tiers activos del tenant';
  END IF;

  INSERT INTO _tst_ctx VALUES (
    v_actor_id, v_actor_auth_id, v_mock_id,
    v_tier_a, v_tier_b, v_tenant
  );
END $ctx$;

-- ── baselines ──────────────────────────────────────────────────────────────

CREATE TEMP TABLE _tst_baseline_user AS
  SELECT * FROM usuarios WHERE id IN (
    (SELECT actor_id FROM _tst_ctx), (SELECT mock_id FROM _tst_ctx)
  );

CREATE TEMP TABLE _tst_baseline_mem AS
  SELECT * FROM membresias
  WHERE usuario_id IN (
    (SELECT actor_id FROM _tst_ctx), (SELECT mock_id FROM _tst_ctx)
  );

CREATE TEMP TABLE _tst_baseline_tier AS
  SELECT * FROM tiers
  WHERE id IN (
    (SELECT tier_a_id FROM _tst_ctx), (SELECT tier_b_id FROM _tst_ctx)
  );

-- Movimientos: fila completa, no solo ids. Si un test borra una membresía,
-- los movimientos asociados se van por cascade — el reset los re-INSERTa
-- desde acá para volver al estado original.
CREATE TEMP TABLE _tst_baseline_movimientos AS
  SELECT * FROM membresia_movimientos;

INSERT INTO _tst_results VALUES (
  0, 'SETUP', TRUE,
  format('actor=%s mock=%s tier_a=%s tier_b=%s baseline_movs=%s',
    (SELECT actor_id FROM _tst_ctx),
    (SELECT mock_id FROM _tst_ctx),
    (SELECT tier_a_id FROM _tst_ctx),
    (SELECT tier_b_id FROM _tst_ctx),
    (SELECT count(*) FROM _tst_baseline_movimientos))
);

-- ── _reset() ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pg_temp._reset()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- 1. Borrar movimientos NUEVOS (los que no estaban al setup).
  DELETE FROM membresia_movimientos
  WHERE id NOT IN (SELECT id FROM _tst_baseline_movimientos);

  -- 2. Borrar membresías NUEVAS (las que no estaban al setup). Esto puede
  --    cascadear-borrar movimientos baseline si la membresía nueva los
  --    referenciaba — no aplica acá porque los nuevos ya están dropeados.
  DELETE FROM membresias
  WHERE usuario_id IN ((SELECT actor_id FROM _tst_ctx), (SELECT mock_id FROM _tst_ctx))
    AND id NOT IN (SELECT id FROM _tst_baseline_mem);

  -- 3. Restaurar membresías baseline EXISTENTES (UPDATE las que sobrevivieron).
  UPDATE membresias m
  SET status = b.status,
      tier_id = b.tier_id,
      periodo_actual_inicio = b.periodo_actual_inicio,
      periodo_actual_fin = b.periodo_actual_fin,
      creditos_restantes = b.creditos_restantes
  FROM _tst_baseline_mem b
  WHERE m.id = b.id;

  -- 4. Re-INSERTAR membresías baseline que fueron BORRADAS por algún test.
  --    Sin esto, el UPDATE anterior no afecta nada y la fila queda perdida
  --    para los tests siguientes (lo que rompía los tests 2-6 y 10).
  INSERT INTO membresias
  SELECT * FROM _tst_baseline_mem b
  WHERE b.id NOT IN (SELECT id FROM membresias);

  -- 5. Re-INSERTAR movimientos baseline que fueron cascade-borrados al
  --    eliminar su membresía en algún test. Idem: sin esto el conteo de
  --    "movimientos nuevos" del próximo test queda desbalanceado.
  INSERT INTO membresia_movimientos
  SELECT * FROM _tst_baseline_movimientos b
  WHERE b.id NOT IN (SELECT id FROM membresia_movimientos);

  -- 6. Restaurar usuarios (David + mock).
  UPDATE usuarios u
  SET rol = b.rol,
      status = b.status,
      membresia_tier = b.membresia_tier,
      membresia_activa_id = b.membresia_activa_id
  FROM _tst_baseline_user b
  WHERE u.id = b.id;

  -- 7. Restaurar tiers (tipo / clases_incluidas / duracion / activo).
  UPDATE tiers t
  SET tipo = b.tipo,
      clases_incluidas = b.clases_incluidas,
      duracion_dias = b.duracion_dias,
      activo = b.activo
  FROM _tst_baseline_tier b
  WHERE t.id = b.id;
END $$;

-- ============================================================================
-- TEST 1 — Alta de socio recién creado (pendiente_pago → activo, crea membresía)
-- ============================================================================
SELECT pg_temp._reset();
-- Simular socio recién creado por admin-create-user: borrar su membresía + status pendiente_pago
DELETE FROM membresia_movimientos WHERE membresia_id IN (
  SELECT id FROM membresias WHERE usuario_id = (SELECT mock_id FROM _tst_ctx)
);
DELETE FROM membresias WHERE usuario_id = (SELECT mock_id FROM _tst_ctx);
UPDATE usuarios SET status = 'pendiente_pago', membresia_activa_id = NULL
WHERE id = (SELECT mock_id FROM _tst_ctx);

-- David como admin (actor)
UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT actor_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT actor_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_result jsonb;
  v_mock uuid := (SELECT mock_id FROM _tst_ctx);
  v_tier uuid := (SELECT tier_a_id FROM _tst_ctx);
  v_status_after text;
  v_mem_count integer;
  v_mov record;
BEGIN
  v_result := gestionar_membresia_socio(v_mock, v_tier, NULL);

  SELECT status INTO v_status_after FROM usuarios WHERE id = v_mock;
  SELECT count(*) INTO v_mem_count FROM membresias
    WHERE usuario_id = v_mock AND status = 'activa';
  SELECT tipo, delta_creditos, created_by INTO v_mov
  FROM membresia_movimientos
  WHERE membresia_id = (v_result->>'membresia_id')::uuid AND tipo = 'alta';

  IF (v_result->>'success')::boolean
     AND (v_result->>'modo') = 'alta'
     AND v_status_after = 'activo'
     AND v_mem_count = 1
     AND v_mov.tipo = 'alta'
     AND v_mov.created_by = (SELECT actor_id FROM _tst_ctx) THEN
    INSERT INTO _tst_results VALUES (1, 'Alta socio nuevo (pendiente_pago → activo)', TRUE,
      format('modo=alta, status=activo, 1 membresía activa, mov.created_by=admin'));
  ELSE
    INSERT INTO _tst_results VALUES (1, 'Alta socio nuevo (pendiente_pago → activo)', FALSE,
      format('modo=%s status=%s mems=%s mov=%s/%s by=%s',
        v_result->>'modo', v_status_after, v_mem_count,
        v_mov.tipo, v_mov.delta_creditos, v_mov.created_by));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (1, 'Alta socio nuevo (pendiente_pago → activo)', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 2 — Renovar vigente mismo tipo (SUMA fechas)
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'tiempo', duracion_dias = 30, clases_incluidas = NULL
WHERE id = (SELECT tier_a_id FROM _tst_ctx);

-- Anclar la membresía del mock al tier_a con fin = now + 10 días
UPDATE membresias
SET tier_id = (SELECT tier_a_id FROM _tst_ctx),
    status = 'activa',
    periodo_actual_fin = now() + interval '10 days',
    creditos_restantes = NULL
WHERE usuario_id = (SELECT mock_id FROM _tst_ctx);

UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT actor_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT actor_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_result jsonb;
  v_mock uuid := (SELECT mock_id FROM _tst_ctx);
  v_tier uuid := (SELECT tier_a_id FROM _tst_ctx);
  v_fin_after timestamptz;
  v_esperado_fin timestamptz;
BEGIN
  -- Esperado: 10 días que le quedaban + 30 = 40 días desde ahora
  v_esperado_fin := now() + interval '40 days';

  v_result := gestionar_membresia_socio(v_mock, v_tier, NULL);

  SELECT periodo_actual_fin INTO v_fin_after FROM membresias
  WHERE id = (v_result->>'membresia_id')::uuid;

  -- Tolerancia 2 minutos por la duración del bloque
  IF (v_result->>'modo') = 'renovacion'
     AND abs(extract(epoch FROM (v_fin_after - v_esperado_fin))) < 120 THEN
    INSERT INTO _tst_results VALUES (2, 'Renovar vigente mismo tipo (SUMA fechas)', TRUE,
      format('modo=renovacion, fin=now+40d (esperado %s, real %s)',
        v_esperado_fin, v_fin_after));
  ELSE
    INSERT INTO _tst_results VALUES (2, 'Renovar vigente mismo tipo (SUMA fechas)', FALSE,
      format('modo=%s fin_real=%s fin_esperado=%s',
        v_result->>'modo', v_fin_after, v_esperado_fin));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (2, 'Renovar vigente mismo tipo (SUMA fechas)', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 3 — Renovar VENCIDA mismo tipo (desde hoy, NO suma al fin pasado)
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'tiempo', duracion_dias = 30, clases_incluidas = NULL
WHERE id = (SELECT tier_a_id FROM _tst_ctx);

-- Anclar la membresía del mock al tier_a con fin VENCIDO (hace 5 días)
UPDATE membresias
SET tier_id = (SELECT tier_a_id FROM _tst_ctx),
    status = 'activa',
    periodo_actual_fin = now() - interval '5 days',
    creditos_restantes = NULL
WHERE usuario_id = (SELECT mock_id FROM _tst_ctx);

UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT actor_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT actor_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_result jsonb;
  v_fin_after timestamptz;
  v_esperado_fin timestamptz;
BEGIN
  v_esperado_fin := now() + interval '30 days';

  v_result := gestionar_membresia_socio(
    (SELECT mock_id FROM _tst_ctx), (SELECT tier_a_id FROM _tst_ctx), NULL
  );

  SELECT periodo_actual_fin INTO v_fin_after FROM membresias
  WHERE id = (v_result->>'membresia_id')::uuid;

  IF (v_result->>'modo') = 'renovacion_desde_hoy'
     AND abs(extract(epoch FROM (v_fin_after - v_esperado_fin))) < 120 THEN
    INSERT INTO _tst_results VALUES (3, 'Renovar vencida mismo tipo (desde hoy)', TRUE,
      format('modo=renovacion_desde_hoy, fin=now+30d (real %s)', v_fin_after));
  ELSE
    INSERT INTO _tst_results VALUES (3, 'Renovar vencida mismo tipo (desde hoy)', FALSE,
      format('modo=%s fin_real=%s fin_esperado=%s',
        v_result->>'modo', v_fin_after, v_esperado_fin));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (3, 'Renovar vencida mismo tipo (desde hoy)', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 4 — Recargar créditos mismo tipo (SUMA saldo)
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_a_id FROM _tst_ctx);

UPDATE membresias
SET tier_id = (SELECT tier_a_id FROM _tst_ctx),
    status = 'activa',
    periodo_actual_fin = NULL,
    creditos_restantes = 3
WHERE usuario_id = (SELECT mock_id FROM _tst_ctx);

UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT actor_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT actor_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_result jsonb;
  v_saldo integer;
  v_mov record;
BEGIN
  v_result := gestionar_membresia_socio(
    (SELECT mock_id FROM _tst_ctx), (SELECT tier_a_id FROM _tst_ctx), NULL
  );

  SELECT creditos_restantes INTO v_saldo FROM membresias
  WHERE id = (v_result->>'membresia_id')::uuid;
  SELECT tipo, delta_creditos INTO v_mov FROM membresia_movimientos
  WHERE membresia_id = (v_result->>'membresia_id')::uuid AND tipo = 'alta';

  -- Esperado: saldo 3 + 10 = 13. Delta = 10 (un solo mov 'alta'). modo=renovacion
  IF (v_result->>'modo') = 'renovacion'
     AND v_saldo = 13
     AND (v_result->>'creditos_restantes')::integer = 13
     AND v_mov.tipo = 'alta' AND v_mov.delta_creditos = 10 THEN
    INSERT INTO _tst_results VALUES (4, 'Recargar créditos mismo tipo (SUMA saldo)', TRUE,
      'saldo 3+10=13, delta=10, modo=renovacion, 1 mov alta');
  ELSE
    INSERT INTO _tst_results VALUES (4, 'Recargar créditos mismo tipo (SUMA saldo)', FALSE,
      format('modo=%s saldo=%s return.cred=%s mov=%s/%s',
        v_result->>'modo', v_saldo, v_result->>'creditos_restantes',
        v_mov.tipo, v_mov.delta_creditos));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (4, 'Recargar créditos mismo tipo (SUMA saldo)', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 5 — Cambio de tipo créditos→tiempo (RESET + DOS movimientos)
-- ============================================================================
SELECT pg_temp._reset();
-- tier_a → tipo=creditos con saldo. tier_b → tipo=tiempo. Mock arranca en tier_a con 5 créditos.
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_a_id FROM _tst_ctx);
UPDATE tiers SET tipo = 'tiempo', duracion_dias = 30, clases_incluidas = NULL
WHERE id = (SELECT tier_b_id FROM _tst_ctx);

UPDATE membresias
SET tier_id = (SELECT tier_a_id FROM _tst_ctx),
    status = 'activa',
    periodo_actual_fin = NULL,
    creditos_restantes = 5
WHERE usuario_id = (SELECT mock_id FROM _tst_ctx);

UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT actor_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT actor_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_result jsonb;
  v_saldo integer;
  v_expiracion record;
  v_alta record;
  v_total_movs integer;
BEGIN
  v_result := gestionar_membresia_socio(
    (SELECT mock_id FROM _tst_ctx), (SELECT tier_b_id FROM _tst_ctx), NULL
  );

  SELECT creditos_restantes INTO v_saldo FROM membresias
  WHERE id = (v_result->>'membresia_id')::uuid;

  SELECT tipo, delta_creditos INTO v_expiracion FROM membresia_movimientos
  WHERE membresia_id = (v_result->>'membresia_id')::uuid AND tipo = 'expiracion';

  SELECT tipo, delta_creditos INTO v_alta FROM membresia_movimientos
  WHERE membresia_id = (v_result->>'membresia_id')::uuid AND tipo = 'alta'
  ORDER BY created_at DESC LIMIT 1;

  SELECT count(*) INTO v_total_movs FROM membresia_movimientos
  WHERE membresia_id = (v_result->>'membresia_id')::uuid
    AND id NOT IN (SELECT id FROM _tst_baseline_movimientos);

  -- Esperado: modo=cambio_de_tipo, saldo NULL (nuevo es tiempo), DOS movimientos:
  -- 'expiracion' delta=-5, 'alta' delta=0
  IF (v_result->>'modo') = 'cambio_de_tipo'
     AND v_saldo IS NULL
     AND v_total_movs = 2
     AND v_expiracion.tipo = 'expiracion' AND v_expiracion.delta_creditos = -5
     AND v_alta.tipo = 'alta' AND v_alta.delta_creditos = 0 THEN
    INSERT INTO _tst_results VALUES (5, 'Cambio créditos→tiempo (reset + 2 movs)', TRUE,
      'modo=cambio_de_tipo, saldo NULL, expiracion=-5 + alta=0 (2 movs)');
  ELSE
    INSERT INTO _tst_results VALUES (5, 'Cambio créditos→tiempo (reset + 2 movs)', FALSE,
      format('modo=%s saldo=%s movs=%s expir=%s/%s alta=%s/%s',
        v_result->>'modo', v_saldo, v_total_movs,
        v_expiracion.tipo, v_expiracion.delta_creditos,
        v_alta.tipo, v_alta.delta_creditos));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (5, 'Cambio créditos→tiempo (reset + 2 movs)', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 6 — Cambio de tipo tiempo→créditos (reset, UN solo movimiento alta)
-- ============================================================================
SELECT pg_temp._reset();
-- tier_a → tipo=tiempo (anclaje del mock). tier_b → tipo=creditos. Mock sin créditos.
UPDATE tiers SET tipo = 'tiempo', duracion_dias = 30, clases_incluidas = NULL
WHERE id = (SELECT tier_a_id FROM _tst_ctx);
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_b_id FROM _tst_ctx);

UPDATE membresias
SET tier_id = (SELECT tier_a_id FROM _tst_ctx),
    status = 'activa',
    periodo_actual_fin = now() + interval '15 days',
    creditos_restantes = NULL
WHERE usuario_id = (SELECT mock_id FROM _tst_ctx);

UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT actor_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT actor_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_result jsonb;
  v_saldo integer;
  v_alta record;
  v_expir_count integer;
  v_total_movs integer;
BEGIN
  v_result := gestionar_membresia_socio(
    (SELECT mock_id FROM _tst_ctx), (SELECT tier_b_id FROM _tst_ctx), NULL
  );

  SELECT creditos_restantes INTO v_saldo FROM membresias
  WHERE id = (v_result->>'membresia_id')::uuid;
  SELECT tipo, delta_creditos INTO v_alta FROM membresia_movimientos
  WHERE membresia_id = (v_result->>'membresia_id')::uuid AND tipo = 'alta';
  SELECT count(*) INTO v_expir_count FROM membresia_movimientos
  WHERE membresia_id = (v_result->>'membresia_id')::uuid AND tipo = 'expiracion';
  SELECT count(*) INTO v_total_movs FROM membresia_movimientos
  WHERE membresia_id = (v_result->>'membresia_id')::uuid
    AND id NOT IN (SELECT id FROM _tst_baseline_movimientos);

  -- Esperado: modo=cambio_de_tipo, saldo=10, UN solo mov 'alta' delta=10, 0 'expiracion'
  IF (v_result->>'modo') = 'cambio_de_tipo'
     AND v_saldo = 10
     AND v_total_movs = 1
     AND v_alta.tipo = 'alta' AND v_alta.delta_creditos = 10
     AND v_expir_count = 0 THEN
    INSERT INTO _tst_results VALUES (6, 'Cambio tiempo→créditos (reset, 1 mov alta)', TRUE,
      'modo=cambio_de_tipo, saldo=10, 1 mov alta=10, sin expiracion (no había créditos previos)');
  ELSE
    INSERT INTO _tst_results VALUES (6, 'Cambio tiempo→créditos (reset, 1 mov alta)', FALSE,
      format('modo=%s saldo=%s total_movs=%s alta=%s/%s expir_count=%s',
        v_result->>'modo', v_saldo, v_total_movs,
        v_alta.tipo, v_alta.delta_creditos, v_expir_count));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (6, 'Cambio tiempo→créditos (reset, 1 mov alta)', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 7 — Sincroniza usuarios.membresia_tier + membresia_activa_id
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'tiempo', duracion_dias = 30, clases_incluidas = NULL
WHERE id IN ((SELECT tier_a_id FROM _tst_ctx), (SELECT tier_b_id FROM _tst_ctx));

-- Mock arranca con tier_a; vamos a moverlo a tier_b y verificar sincronización
UPDATE membresias
SET tier_id = (SELECT tier_a_id FROM _tst_ctx),
    status = 'activa',
    periodo_actual_fin = now() + interval '10 days'
WHERE usuario_id = (SELECT mock_id FROM _tst_ctx);

UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT actor_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT actor_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_result jsonb;
  v_user_tier_after text;
  v_user_mem_id_after uuid;
  v_tier_b_slug text;
BEGIN
  SELECT slug INTO v_tier_b_slug FROM tiers WHERE id = (SELECT tier_b_id FROM _tst_ctx);

  v_result := gestionar_membresia_socio(
    (SELECT mock_id FROM _tst_ctx), (SELECT tier_b_id FROM _tst_ctx), NULL
  );

  SELECT membresia_tier, membresia_activa_id
  INTO v_user_tier_after, v_user_mem_id_after
  FROM usuarios WHERE id = (SELECT mock_id FROM _tst_ctx);

  IF v_user_tier_after = v_tier_b_slug
     AND v_user_mem_id_after = (v_result->>'membresia_id')::uuid THEN
    INSERT INTO _tst_results VALUES (7, 'Sincroniza membresia_tier + membresia_activa_id', TRUE,
      format('tier=%s mem_id=%s', v_user_tier_after, v_user_mem_id_after));
  ELSE
    INSERT INTO _tst_results VALUES (7, 'Sincroniza membresia_tier + membresia_activa_id', FALSE,
      format('tier_after=%s (esperado %s) mem_id_after=%s (esperado %s)',
        v_user_tier_after, v_tier_b_slug,
        v_user_mem_id_after, v_result->>'membresia_id'));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (7, 'Sincroniza membresia_tier + membresia_activa_id', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 8 — Solo staff puede: miembro intenta auto-renovarse → NO_AUTORIZADO
-- ============================================================================
SELECT pg_temp._reset();
-- David queda como 'miembro' (su rol natural, sin tocar). Intenta llamar el RPC
-- pasando su propio id como objetivo. Debe fallar NO_AUTORIZADO.
SELECT pg_temp._as((SELECT actor_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_err text;
BEGIN
  PERFORM gestionar_membresia_socio(
    (SELECT actor_id FROM _tst_ctx),
    (SELECT tier_a_id FROM _tst_ctx),
    NULL
  );
  INSERT INTO _tst_results VALUES (8, 'Miembro no puede auto-renovarse (NO_AUTORIZADO)', FALSE,
    'no falló (esperado NO_AUTORIZADO)');
EXCEPTION WHEN OTHERS THEN
  v_err := SQLERRM;
  IF v_err LIKE 'NO_AUTORIZADO%' THEN
    INSERT INTO _tst_results VALUES (8, 'Miembro no puede auto-renovarse (NO_AUTORIZADO)', TRUE, v_err);
  ELSE
    INSERT INTO _tst_results VALUES (8, 'Miembro no puede auto-renovarse (NO_AUTORIZADO)', FALSE,
      'esperado NO_AUTORIZADO, recibido: ' || v_err);
  END IF;
END $t$;

-- ============================================================================
-- TEST 9 — Tier inactivo → TIER_INACTIVO
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET activo = false WHERE id = (SELECT tier_a_id FROM _tst_ctx);
UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT actor_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT actor_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_err text;
BEGIN
  PERFORM gestionar_membresia_socio(
    (SELECT mock_id FROM _tst_ctx),
    (SELECT tier_a_id FROM _tst_ctx),
    NULL
  );
  INSERT INTO _tst_results VALUES (9, 'Tier inactivo → rechaza', FALSE,
    'no falló (esperado TIER_INACTIVO)');
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'TIER_INACTIVO%' THEN
    INSERT INTO _tst_results VALUES (9, 'Tier inactivo → rechaza', TRUE, SQLERRM);
  ELSE
    INSERT INTO _tst_results VALUES (9, 'Tier inactivo → rechaza', FALSE,
      'esperado TIER_INACTIVO, recibido: ' || SQLERRM);
  END IF;
END $t$;

-- ============================================================================
-- TEST 10 — Atomicidad: si el RPC falla, no deja residuo
-- ============================================================================
-- Forzamos un fallo cambiando temporalmente el rol del socio objetivo a 'admin'
-- (ROL_INVALIDO). Verificamos que el saldo/fin/movimientos del mock quedan
-- INTACTOS post-error. Eso valida que el RPC no escribió nada antes de validar.
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_a_id FROM _tst_ctx);

UPDATE membresias
SET tier_id = (SELECT tier_a_id FROM _tst_ctx),
    status = 'activa',
    periodo_actual_fin = now() + interval '10 days',
    creditos_restantes = 7
WHERE usuario_id = (SELECT mock_id FROM _tst_ctx);

-- Hacer al mock 'admin' (rompe ROL_INVALIDO)
UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT mock_id FROM _tst_ctx);
UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT actor_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT actor_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_err text;
  v_saldo_after integer;
  v_movs_nuevos integer;
BEGIN
  BEGIN
    PERFORM gestionar_membresia_socio(
      (SELECT mock_id FROM _tst_ctx),
      (SELECT tier_a_id FROM _tst_ctx),
      NULL
    );
    INSERT INTO _tst_results VALUES (10, 'Atomicidad: error no deja residuo', FALSE,
      'no falló (esperado ROL_INVALIDO)');
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  SELECT creditos_restantes INTO v_saldo_after FROM membresias
  WHERE usuario_id = (SELECT mock_id FROM _tst_ctx);
  SELECT count(*) INTO v_movs_nuevos FROM membresia_movimientos
  WHERE id NOT IN (SELECT id FROM _tst_baseline_movimientos);

  IF v_err LIKE 'ROL_INVALIDO%'
     AND v_saldo_after = 7
     AND v_movs_nuevos = 0 THEN
    INSERT INTO _tst_results VALUES (10, 'Atomicidad: error no deja residuo', TRUE,
      'err=ROL_INVALIDO, saldo intacto (7), 0 movimientos nuevos');
  ELSE
    INSERT INTO _tst_results VALUES (10, 'Atomicidad: error no deja residuo', FALSE,
      format('err=%s saldo=%s movs_nuevos=%s', v_err, v_saldo_after, v_movs_nuevos));
  END IF;
END $t$;

-- ============================================================================
-- Cierre
-- ============================================================================
SELECT pg_temp._reset();
SELECT pg_temp._as(NULL);

SELECT
  n,
  CASE WHEN ok THEN 'OK   ' ELSE 'FAIL ' END AS resultado,
  test,
  detalle
FROM _tst_results
ORDER BY n;

ROLLBACK;
