-- ============================================================================
-- TESTS — Gate de membresías en reservar_clase_atomic (Fase 2A.2)
-- ============================================================================
-- USO: pegar este bloque entero en el SQL Editor de Supabase y ejecutar.
--      Está envuelto en BEGIN/ROLLBACK → NO persiste ningún cambio.
--      El veredicto de los 11 tests sale como TABLA al final (pestaña Results).
--
-- POR QUÉ NO USAMOS SAVEPOINTS — la versión anterior los usaba para aislar
-- cada test, pero ROLLBACK TO SAVEPOINT también revierte el INSERT a
-- _tst_results dentro del savepoint. Resultado: el SELECT final solo veía
-- la fila del SETUP. Acá usamos otra estrategia: snapshots de baseline al
-- inicio + un helper _reset() que restaura el estado entre tests. Los
-- INSERTs a _tst_results quedan en la tx global y solo se revierten en el
-- ROLLBACK final — el SELECT ya devolvió los datos al cliente antes.
--
-- IMPERSONACIÓN — la function reservar_clase_atomic lee auth.uid() desde
-- request.jwt.claims. set_config LOCAL lo sobreescribe — auth.uid() devuelve
-- el sub que le digamos, y get_my_user_id() lo traduce a usuarios.id.
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
  socio_id uuid,
  socio_auth_id uuid,
  socio_email text,
  tier_id uuid,
  mem_id uuid,
  clase1_id uuid,
  clase2_id uuid,
  tenant_id uuid
);

-- ── setup: localizar entidades de test ─────────────────────────────────────

DO $ctx$
DECLARE
  v_socio_id uuid;
  v_socio_auth_id uuid;
  v_tier_id uuid;
  v_mem_id uuid;
  v_clase1 uuid;
  v_clase2 uuid;
  v_tenant uuid;
BEGIN
  SELECT id, auth_id, tenant_id
    INTO v_socio_id, v_socio_auth_id, v_tenant
    FROM usuarios
    WHERE email = 'davidespinunez@gmail.com';

  IF v_socio_id IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: usuario davidespinunez@gmail.com no existe';
  END IF;
  IF v_socio_auth_id IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: davidespinunez no tiene auth_id';
  END IF;

  SELECT id, tier_id INTO v_mem_id, v_tier_id
    FROM membresias
    WHERE usuario_id = v_socio_id AND status = 'activa'
    LIMIT 1;

  IF v_mem_id IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: davidespinunez no tiene membresía activa';
  END IF;

  SELECT c.id INTO v_clase1
  FROM clases c
  WHERE c.tenant_id = v_tenant
    AND c.status = 'programada'
    AND (c.fecha + c.hora_inicio)::timestamp > (now() + interval '25 hours')
    AND NOT EXISTS (
      SELECT 1 FROM reservas r
      WHERE r.clase_id = c.id AND r.usuario_id = v_socio_id
        AND r.status IN ('confirmada','completada')
    )
    AND (
      SELECT count(*) FROM reservas r
      WHERE r.clase_id = c.id AND r.status IN ('confirmada','completada')
    ) < c.cupo_max
  ORDER BY (c.fecha + c.hora_inicio) ASC
  LIMIT 1;

  IF v_clase1 IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: no se encontró clase futura con cupo libre';
  END IF;

  SELECT c.id INTO v_clase2
  FROM clases c
  WHERE c.tenant_id = v_tenant
    AND c.id <> v_clase1
    AND c.status = 'programada'
    AND (c.fecha + c.hora_inicio)::timestamp > (now() + interval '25 hours')
    AND NOT EXISTS (
      SELECT 1 FROM reservas r
      WHERE r.clase_id = c.id AND r.usuario_id = v_socio_id
        AND r.status IN ('confirmada','completada')
    )
    AND (
      SELECT count(*) FROM reservas r
      WHERE r.clase_id = c.id AND r.status IN ('confirmada','completada')
    ) < c.cupo_max
  ORDER BY (c.fecha + c.hora_inicio) ASC
  LIMIT 1;

  IF v_clase2 IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: no se encontró 2da clase distinta';
  END IF;

  INSERT INTO _tst_ctx VALUES (
    v_socio_id, v_socio_auth_id, 'davidespinunez@gmail.com',
    v_tier_id, v_mem_id, v_clase1, v_clase2, v_tenant
  );
END $ctx$;

-- ── baselines: snapshots del estado pre-test ───────────────────────────────
-- Estas tablas guardan el "valor original" de cada entidad que los tests van
-- a mutar. _reset() las usa para restaurar entre tests.

CREATE TEMP TABLE _tst_baseline_user AS
  SELECT * FROM usuarios WHERE id = (SELECT socio_id FROM _tst_ctx);

CREATE TEMP TABLE _tst_baseline_mem AS
  SELECT * FROM membresias WHERE id = (SELECT mem_id FROM _tst_ctx);

CREATE TEMP TABLE _tst_baseline_tier AS
  SELECT * FROM tiers WHERE id = (SELECT tier_id FROM _tst_ctx);

CREATE TEMP TABLE _tst_baseline_clase AS
  SELECT * FROM clases
  WHERE id IN ((SELECT clase1_id FROM _tst_ctx), (SELECT clase2_id FROM _tst_ctx));

-- Reservas pre-existentes en clase1/clase2 (de otros usuarios típicamente).
-- _reset() borra cualquier reserva en esas clases que NO esté en este snapshot.
CREATE TEMP TABLE _tst_baseline_reservas AS
  SELECT id FROM reservas
  WHERE clase_id IN (SELECT id FROM _tst_baseline_clase);

INSERT INTO _tst_results VALUES (
  0, 'SETUP', TRUE,
  format('socio=%s mem=%s clase1=%s clase2=%s baseline_reservas=%s',
    (SELECT socio_id FROM _tst_ctx),
    (SELECT mem_id FROM _tst_ctx),
    (SELECT clase1_id FROM _tst_ctx),
    (SELECT clase2_id FROM _tst_ctx),
    (SELECT count(*) FROM _tst_baseline_reservas))
);

-- ── helper: restaurar todo al baseline entre tests ─────────────────────────

CREATE OR REPLACE FUNCTION pg_temp._reset()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Borrar reservas creadas durante tests + movimientos del socio
  DELETE FROM reservas
  WHERE clase_id IN (SELECT id FROM _tst_baseline_clase)
    AND id NOT IN (SELECT id FROM _tst_baseline_reservas);

  DELETE FROM membresia_movimientos
  WHERE membresia_id = (SELECT mem_id FROM _tst_ctx);

  -- Restaurar usuarios (campos que los tests mutan)
  UPDATE usuarios u
  SET rol = b.rol,
      status = b.status,
      bloqueado_hasta = b.bloqueado_hasta,
      membresia_activa_id = b.membresia_activa_id,
      membresia_tier = b.membresia_tier
  FROM _tst_baseline_user b
  WHERE u.id = b.id;

  -- Restaurar membresias
  UPDATE membresias m
  SET status = b.status,
      periodo_actual_inicio = b.periodo_actual_inicio,
      periodo_actual_fin = b.periodo_actual_fin,
      creditos_restantes = b.creditos_restantes
  FROM _tst_baseline_mem b
  WHERE m.id = b.id;

  -- Restaurar tiers
  UPDATE tiers t
  SET tipo = b.tipo,
      clases_incluidas = b.clases_incluidas,
      duracion_dias = b.duracion_dias
  FROM _tst_baseline_tier b
  WHERE t.id = b.id;

  -- Restaurar clases
  UPDATE clases c
  SET cupo_max = b.cupo_max
  FROM _tst_baseline_clase b
  WHERE c.id = b.id;
END $$;

-- ============================================================================
-- TEST 1 — SIN_MEMBRESIA bloquea
-- ============================================================================
SELECT pg_temp._reset();
UPDATE membresias SET status = 'cancelada'
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_err text;
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
BEGIN
  PERFORM reservar_clase_atomic(v_clase, 0, NULL);
  INSERT INTO _tst_results VALUES (1, 'SIN_MEMBRESIA bloquea', FALSE,
    'no falló (esperado SIN_MEMBRESIA)');
EXCEPTION WHEN OTHERS THEN
  v_err := SQLERRM;
  IF v_err LIKE 'SIN_MEMBRESIA%' THEN
    INSERT INTO _tst_results VALUES (1, 'SIN_MEMBRESIA bloquea', TRUE, v_err);
  ELSE
    INSERT INTO _tst_results VALUES (1, 'SIN_MEMBRESIA bloquea', FALSE,
      'esperado SIN_MEMBRESIA, recibido: ' || v_err);
  END IF;
END $t$;

-- ============================================================================
-- TEST 2 — MEMBRESIA_CONGELADA bloquea
-- ============================================================================
SELECT pg_temp._reset();
UPDATE membresias SET status = 'congelada'
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_err text;
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
BEGIN
  PERFORM reservar_clase_atomic(v_clase, 0, NULL);
  INSERT INTO _tst_results VALUES (2, 'MEMBRESIA_CONGELADA bloquea', FALSE,
    'no falló (esperado MEMBRESIA_CONGELADA)');
EXCEPTION WHEN OTHERS THEN
  v_err := SQLERRM;
  IF v_err LIKE 'MEMBRESIA_CONGELADA%' THEN
    INSERT INTO _tst_results VALUES (2, 'MEMBRESIA_CONGELADA bloquea', TRUE, v_err);
  ELSE
    INSERT INTO _tst_results VALUES (2, 'MEMBRESIA_CONGELADA bloquea', FALSE,
      'esperado MEMBRESIA_CONGELADA, recibido: ' || v_err);
  END IF;
END $t$;

-- ============================================================================
-- TEST 3 — MEMBRESIA_VENCIDA (tipo=tiempo) bloquea
-- ============================================================================
SELECT pg_temp._reset();
UPDATE membresias SET periodo_actual_fin = now() - interval '1 day'
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_err text;
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
BEGIN
  PERFORM reservar_clase_atomic(v_clase, 0, NULL);
  INSERT INTO _tst_results VALUES (3, 'MEMBRESIA_VENCIDA (tiempo)', FALSE,
    'no falló (esperado MEMBRESIA_VENCIDA)');
EXCEPTION WHEN OTHERS THEN
  v_err := SQLERRM;
  IF v_err LIKE 'MEMBRESIA_VENCIDA%' THEN
    INSERT INTO _tst_results VALUES (3, 'MEMBRESIA_VENCIDA (tiempo)', TRUE, v_err);
  ELSE
    INSERT INTO _tst_results VALUES (3, 'MEMBRESIA_VENCIDA (tiempo)', FALSE,
      'esperado MEMBRESIA_VENCIDA, recibido: ' || v_err);
  END IF;
END $t$;

-- ============================================================================
-- TEST 4 — SIN_CREDITOS (tipo=creditos) bloquea
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 0, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_err text;
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
BEGIN
  PERFORM reservar_clase_atomic(v_clase, 0, NULL);
  INSERT INTO _tst_results VALUES (4, 'SIN_CREDITOS (creditos)', FALSE,
    'no falló (esperado SIN_CREDITOS)');
EXCEPTION WHEN OTHERS THEN
  v_err := SQLERRM;
  IF v_err LIKE 'SIN_CREDITOS%' THEN
    INSERT INTO _tst_results VALUES (4, 'SIN_CREDITOS (creditos)', TRUE, v_err);
  ELSE
    INSERT INTO _tst_results VALUES (4, 'SIN_CREDITOS (creditos)', FALSE,
      'esperado SIN_CREDITOS, recibido: ' || v_err);
  END IF;
END $t$;

-- ============================================================================
-- TEST 5 — HÍBRIDO bloquea por vencimiento (prioridad vencido > sin saldo)
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'hibrido', clases_incluidas = 10, duracion_dias = 30
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias
SET creditos_restantes = 5, periodo_actual_fin = now() - interval '1 day'
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_err text;
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
BEGIN
  PERFORM reservar_clase_atomic(v_clase, 0, NULL);
  INSERT INTO _tst_results VALUES (5, 'Híbrido vencido (con créditos)', FALSE,
    'no falló (esperado MEMBRESIA_VENCIDA)');
EXCEPTION WHEN OTHERS THEN
  v_err := SQLERRM;
  IF v_err LIKE 'MEMBRESIA_VENCIDA%' THEN
    INSERT INTO _tst_results VALUES (5, 'Híbrido vencido (con créditos)', TRUE, v_err);
  ELSE
    INSERT INTO _tst_results VALUES (5, 'Híbrido vencido (con créditos)', FALSE,
      'esperado MEMBRESIA_VENCIDA, recibido: ' || v_err);
  END IF;
END $t$;

-- ============================================================================
-- TEST 6 — HÍBRIDO bloquea por sin créditos (vigente pero saldo=0)
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'hibrido', clases_incluidas = 10, duracion_dias = 30
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias
SET creditos_restantes = 0, periodo_actual_fin = now() + interval '30 days'
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_err text;
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
BEGIN
  PERFORM reservar_clase_atomic(v_clase, 0, NULL);
  INSERT INTO _tst_results VALUES (6, 'Híbrido vigente sin créditos', FALSE,
    'no falló (esperado SIN_CREDITOS)');
EXCEPTION WHEN OTHERS THEN
  v_err := SQLERRM;
  IF v_err LIKE 'SIN_CREDITOS%' THEN
    INSERT INTO _tst_results VALUES (6, 'Híbrido vigente sin créditos', TRUE, v_err);
  ELSE
    INSERT INTO _tst_results VALUES (6, 'Híbrido vigente sin créditos', FALSE,
      'esperado SIN_CREDITOS, recibido: ' || v_err);
  END IF;
END $t$;

-- ============================================================================
-- TEST 7 — TIEMPO vigente: reserva OK, NO debita
-- ============================================================================
SELECT pg_temp._reset();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_result jsonb;
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_creditos_after integer;
  v_mov_count integer;
BEGIN
  v_result := reservar_clase_atomic(v_clase, 0, NULL);

  SELECT creditos_restantes INTO v_creditos_after FROM membresias WHERE id = v_mem;
  SELECT count(*) INTO v_mov_count FROM membresia_movimientos
    WHERE membresia_id = v_mem AND tipo = 'debito'
      AND reserva_id = (v_result->>'reserva_id')::uuid;

  IF (v_result->>'success')::boolean
     AND v_creditos_after IS NULL
     AND v_mov_count = 0 THEN
    INSERT INTO _tst_results VALUES (7, 'Tiempo vigente reserva sin debitar', TRUE,
      format('saldo=NULL, débitos=0, folio=%s', v_result->>'folio'));
  ELSE
    INSERT INTO _tst_results VALUES (7, 'Tiempo vigente reserva sin debitar', FALSE,
      format('success=%s saldo_after=%s débitos=%s',
        v_result->>'success', v_creditos_after, v_mov_count));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (7, 'Tiempo vigente reserva sin debitar', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 8 — CRÉDITOS vigente: reserva OK, debita 1, escribe movimiento
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_result jsonb;
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_creditos_after integer;
  v_mov record;
BEGIN
  v_result := reservar_clase_atomic(v_clase, 0, NULL);

  SELECT creditos_restantes INTO v_creditos_after FROM membresias WHERE id = v_mem;
  SELECT tipo, delta_creditos, reserva_id, motivo INTO v_mov
  FROM membresia_movimientos
  WHERE membresia_id = v_mem AND reserva_id = (v_result->>'reserva_id')::uuid;

  IF (v_result->>'success')::boolean
     AND v_creditos_after = 4
     AND v_mov.tipo = 'debito'
     AND v_mov.delta_creditos = -1
     AND (v_result->>'creditos_restantes')::integer = 4 THEN
    INSERT INTO _tst_results VALUES (8, 'Créditos>0 reserva y debita 1', TRUE,
      format('saldo 5→4, mov.tipo=%s delta=%s motivo="%s"',
        v_mov.tipo, v_mov.delta_creditos, v_mov.motivo));
  ELSE
    INSERT INTO _tst_results VALUES (8, 'Créditos>0 reserva y debita 1', FALSE,
      format('success=%s saldo_after=%s mov.tipo=%s delta=%s return.creditos=%s',
        v_result->>'success', v_creditos_after, v_mov.tipo,
        v_mov.delta_creditos, v_result->>'creditos_restantes'));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (8, 'Créditos>0 reserva y debita 1', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 9 — STAFF reserva sin membresía
-- ============================================================================
SELECT pg_temp._reset();
UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT socio_id FROM _tst_ctx);
UPDATE membresias SET status = 'cancelada' WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_result jsonb;
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mov_count integer;
BEGIN
  v_result := reservar_clase_atomic(v_clase, 0, NULL);

  SELECT count(*) INTO v_mov_count FROM membresia_movimientos
    WHERE reserva_id = (v_result->>'reserva_id')::uuid;

  IF (v_result->>'success')::boolean
     AND v_mov_count = 0
     AND v_result->>'creditos_restantes' IS NULL THEN
    INSERT INTO _tst_results VALUES (9, 'Staff/admin reserva sin gate', TRUE,
      format('movimientos=0, folio=%s, return.creditos=NULL', v_result->>'folio'));
  ELSE
    INSERT INTO _tst_results VALUES (9, 'Staff/admin reserva sin gate', FALSE,
      format('success=%s movs=%s creditos_return=%s',
        v_result->>'success', v_mov_count, v_result->>'creditos_restantes'));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (9, 'Staff/admin reserva sin gate', FALSE,
    'staff bloqueado erróneamente: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 10 — Cupo lleno: NO debita
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);

-- Llenar cupo: insertar 1 reserva mock de otro socio + cupo_max=1
INSERT INTO reservas (
  tenant_id, recurso_id, usuario_id,
  slot_inicio, slot_fin, duracion_min,
  invitados_count, status, folio, clase_id, notas
)
SELECT
  c.tenant_id,
  c.recurso_id,
  (
    SELECT u.id FROM usuarios u
    WHERE u.tenant_id = c.tenant_id
      AND u.rol = 'miembro'
      AND u.id <> (SELECT socio_id FROM _tst_ctx)
    LIMIT 1
  ),
  (c.fecha + c.hora_inicio) AT TIME ZONE timezone_de_sucursal(c.sucursal_id, c.tenant_id),
  (c.fecha + c.hora_inicio) AT TIME ZONE timezone_de_sucursal(c.sucursal_id, c.tenant_id)
    + (c.duracion_minutos || ' minutes')::interval,
  c.duracion_minutos,
  0, 'confirmada',
  'TST-' || lpad((floor(random() * 999999))::int::text, 6, '0'),
  c.id,
  'mock reserva para test 10'
FROM clases c
WHERE c.id = (SELECT clase1_id FROM _tst_ctx);

UPDATE clases SET cupo_max = 1
WHERE id = (SELECT clase1_id FROM _tst_ctx);

SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_err text;
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_creditos_after integer;
  v_mov_count integer;
BEGIN
  BEGIN
    PERFORM reservar_clase_atomic(v_clase, 0, NULL);
    INSERT INTO _tst_results VALUES (10, 'Cupo lleno NO debita', FALSE,
      'no falló (esperado CUPO_LLENO)');
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  SELECT creditos_restantes INTO v_creditos_after FROM membresias WHERE id = v_mem;
  SELECT count(*) INTO v_mov_count FROM membresia_movimientos
    WHERE membresia_id = v_mem AND tipo = 'debito';

  IF v_err LIKE 'CUPO_LLENO%'
     AND v_creditos_after = 5
     AND v_mov_count = 0 THEN
    INSERT INTO _tst_results VALUES (10, 'Cupo lleno NO debita', TRUE,
      'err=CUPO_LLENO, saldo=5, débitos=0');
  ELSE
    INSERT INTO _tst_results VALUES (10, 'Cupo lleno NO debita', FALSE,
      format('err=%s saldo_after=%s movs=%s', v_err, v_creditos_after, v_mov_count));
  END IF;
END $t$;

-- ============================================================================
-- TEST 11 — Doble reserva: la 2da NO debita (YA_RESERVADO)
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_result1 jsonb;
  v_err text;
  v_creditos_after integer;
  v_debit_count integer;
BEGIN
  v_result1 := reservar_clase_atomic(v_clase, 0, NULL);

  BEGIN
    PERFORM reservar_clase_atomic(v_clase, 0, NULL);
    INSERT INTO _tst_results VALUES (11, 'Doble reserva no debita 2x', FALSE,
      '2da reserva no falló (esperado YA_RESERVADO)');
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  SELECT creditos_restantes INTO v_creditos_after FROM membresias WHERE id = v_mem;
  SELECT count(*) INTO v_debit_count FROM membresia_movimientos
    WHERE membresia_id = v_mem AND tipo = 'debito';

  IF v_err LIKE 'YA_RESERVADO%'
     AND v_creditos_after = 4
     AND v_debit_count = 1 THEN
    INSERT INTO _tst_results VALUES (11, 'Doble reserva no debita 2x', TRUE,
      'err=YA_RESERVADO, saldo=4, débitos=1');
  ELSE
    INSERT INTO _tst_results VALUES (11, 'Doble reserva no debita 2x', FALSE,
      format('err=%s saldo=%s débitos=%s', v_err, v_creditos_after, v_debit_count));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (11, 'Doble reserva no debita 2x', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- Cierre — restaurar todo + descartar la sesión impersonada
-- ============================================================================
SELECT pg_temp._reset();
SELECT pg_temp._as(NULL);

-- ÚLTIMO SELECT: este es el que se ve en Results
SELECT
  n,
  CASE WHEN ok THEN 'OK   ' ELSE 'FAIL ' END AS resultado,
  test,
  detalle
FROM _tst_results
ORDER BY n;

ROLLBACK;
