-- ============================================================================
-- TESTS — D-011 Lista de espera debita/devuelve crédito
-- ============================================================================
-- USO: pegar este bloque entero en el SQL Editor de Supabase y ejecutar.
--      Está envuelto en BEGIN/ROLLBACK → NO persiste ningún cambio.
--      El veredicto sale como TABLA al final (pestaña Results).
--
-- ESTRATEGIA — misma de test_membresias_cancelacion.sql: snapshots de baseline
-- al inicio + helper _reset() entre tests. NO savepoints.
--
-- COBERTURA (15 tests):
--   1.  Anotar (créditos) → debita 1 + movimiento con lista_espera_id
--   2.  SIN_CREDITOS bloquea anotar (saldo 0) — no entrada, no movimiento
--   3.  MEMBRESIA_VENCIDA bloquea anotar — no entrada, no movimiento
--   4.  Tier tipo=tiempo → no debita (entra en lista sin movimiento)
--   5.  Salir a tiempo → devuelve 1 (saldo y ledger ok)
--   6.  Salir doble → 2da llamada NO_EN_LISTA (anti doble-refund)
--   7.  CLASE_PASADA bloquea salir (no refund a destiempo)
--   8.  Admin cancela clase → trigger devuelve crédito a esperando
--   9.  expirar_listas_espera_vencidas marca 'expirada' + refunda
--   10. expirar idempotente — 2da corrida cero efectos
--   11. Cancelar reserva promovida A TIEMPO → fallback devuelve crédito
--   12. Balance global: anotar + salir = neto 0
--   13. Cancelar reserva promovida TARDE → no devuelve (motivo='tarde')
--   14. Doble cancelación de reserva promovida → 2da RESERVA_NO_CANCELABLE,
--       1 sola devolución (anti-doble por reserva_id + lista_espera_id)
--   15. Reserva NORMAL (no promovida) → fallback NO se activa, devolución
--       con lista_espera_id IS NULL (camino feliz preservado)
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
  tier_id uuid,
  mem_id uuid,
  clase1_id uuid,
  tenant_id uuid,
  mock_id uuid,
  mock_mem_id uuid
);

-- ── setup ──────────────────────────────────────────────────────────────────

DO $ctx$
DECLARE
  v_socio_id uuid;
  v_socio_auth_id uuid;
  v_tier_id uuid;
  v_mem_id uuid;
  v_clase1 uuid;
  v_tenant uuid;
  v_mock_id uuid;
  v_mock_mem_id uuid;
BEGIN
  SELECT id, auth_id, tenant_id
    INTO v_socio_id, v_socio_auth_id, v_tenant
    FROM usuarios
    WHERE email = 'davidespinunez@gmail.com';
  IF v_socio_id IS NULL OR v_socio_auth_id IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: davidespinunez sin id/auth_id';
  END IF;

  SELECT id, tier_id INTO v_mem_id, v_tier_id
    FROM membresias
    WHERE usuario_id = v_socio_id AND status = 'activa'
    LIMIT 1;
  IF v_mem_id IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: davidespinunez sin membresía activa';
  END IF;

  SELECT u.id, m.id INTO v_mock_id, v_mock_mem_id
  FROM usuarios u
  JOIN membresias m ON m.usuario_id = u.id AND m.status = 'activa'
  WHERE u.tenant_id = v_tenant
    AND u.rol = 'miembro'
    AND u.id <> v_socio_id
    AND m.tier_id = v_tier_id
  LIMIT 1;
  IF v_mock_id IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: no se encontró 2do socio con mismo tier';
  END IF;

  -- Clase futura (>25h) con cupo > 0 y sin reservas ni entradas del socio/mock.
  -- Vamos a manipular cupo_max=1 + llenar con reserva mock para forzar "lleno".
  SELECT c.id INTO v_clase1
  FROM clases c
  WHERE c.tenant_id = v_tenant
    AND c.status = 'programada'
    AND (c.fecha + c.hora_inicio)::timestamp > (now() + interval '25 hours')
    AND NOT EXISTS (
      SELECT 1 FROM reservas r
      WHERE r.clase_id = c.id
        AND r.usuario_id IN (v_socio_id, v_mock_id)
        AND r.status IN ('confirmada','completada')
    )
    AND NOT EXISTS (
      SELECT 1 FROM lista_espera le
      WHERE le.clase_id = c.id
        AND le.usuario_id IN (v_socio_id, v_mock_id)
        AND le.status = 'esperando'
    )
  ORDER BY (c.fecha + c.hora_inicio) ASC
  LIMIT 1;
  IF v_clase1 IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: no se encontró clase futura limpia';
  END IF;

  INSERT INTO _tst_ctx VALUES (
    v_socio_id, v_socio_auth_id, v_tier_id, v_mem_id,
    v_clase1, v_tenant, v_mock_id, v_mock_mem_id
  );
END $ctx$;

-- ── baselines ──────────────────────────────────────────────────────────────

CREATE TEMP TABLE _tst_baseline_user AS
  SELECT * FROM usuarios WHERE id IN (
    (SELECT socio_id FROM _tst_ctx), (SELECT mock_id FROM _tst_ctx)
  );

CREATE TEMP TABLE _tst_baseline_mem AS
  SELECT * FROM membresias WHERE id IN (
    (SELECT mem_id FROM _tst_ctx), (SELECT mock_mem_id FROM _tst_ctx)
  );

CREATE TEMP TABLE _tst_baseline_tier AS
  SELECT * FROM tiers WHERE id = (SELECT tier_id FROM _tst_ctx);

CREATE TEMP TABLE _tst_baseline_clase AS
  SELECT * FROM clases WHERE id = (SELECT clase1_id FROM _tst_ctx);

CREATE TEMP TABLE _tst_baseline_tenant AS
  SELECT * FROM tenants WHERE id = (SELECT tenant_id FROM _tst_ctx);

CREATE TEMP TABLE _tst_baseline_reservas AS
  SELECT id FROM reservas WHERE clase_id = (SELECT clase1_id FROM _tst_ctx);

CREATE TEMP TABLE _tst_baseline_lista_espera AS
  SELECT id FROM lista_espera WHERE clase_id = (SELECT clase1_id FROM _tst_ctx);

CREATE TEMP TABLE _tst_baseline_movimientos AS
  SELECT id FROM membresia_movimientos;

INSERT INTO _tst_results VALUES (
  0, 'SETUP', TRUE,
  format('socio=%s mock=%s mem=%s clase=%s baseline_movs=%s baseline_le=%s',
    (SELECT socio_id FROM _tst_ctx),
    (SELECT mock_id FROM _tst_ctx),
    (SELECT mem_id FROM _tst_ctx),
    (SELECT clase1_id FROM _tst_ctx),
    (SELECT count(*) FROM _tst_baseline_movimientos),
    (SELECT count(*) FROM _tst_baseline_lista_espera))
);

-- ── _reset() ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pg_temp._reset()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Borrar reservas + entradas + movimientos creados durante los tests
  DELETE FROM reservas
  WHERE clase_id = (SELECT clase1_id FROM _tst_ctx)
    AND id NOT IN (SELECT id FROM _tst_baseline_reservas);

  DELETE FROM lista_espera
  WHERE clase_id = (SELECT clase1_id FROM _tst_ctx)
    AND id NOT IN (SELECT id FROM _tst_baseline_lista_espera);

  DELETE FROM membresia_movimientos
  WHERE id NOT IN (SELECT id FROM _tst_baseline_movimientos);

  -- Restaurar usuarios
  UPDATE usuarios u
  SET rol = b.rol, status = b.status, bloqueado_hasta = b.bloqueado_hasta,
      membresia_activa_id = b.membresia_activa_id, membresia_tier = b.membresia_tier
  FROM _tst_baseline_user b WHERE u.id = b.id;

  -- Restaurar membresías
  UPDATE membresias m
  SET status = b.status, periodo_actual_inicio = b.periodo_actual_inicio,
      periodo_actual_fin = b.periodo_actual_fin, creditos_restantes = b.creditos_restantes
  FROM _tst_baseline_mem b WHERE m.id = b.id;

  -- Restaurar tier
  UPDATE tiers t
  SET tipo = b.tipo, clases_incluidas = b.clases_incluidas, duracion_dias = b.duracion_dias
  FROM _tst_baseline_tier b WHERE t.id = b.id;

  -- Restaurar clase (cupo + status + fecha + hora_inicio — los tests cancelan
  -- la clase y la empujan al pasado para forzar CLASE_PASADA / expirar)
  UPDATE clases c
  SET cupo_max = b.cupo_max,
      status = b.status,
      fecha = b.fecha,
      hora_inicio = b.hora_inicio
  FROM _tst_baseline_clase b WHERE c.id = b.id;

  -- Restaurar tenant config
  UPDATE tenants t SET config = b.config
  FROM _tst_baseline_tenant b WHERE t.id = b.id;
END $$;

-- ── helper: llenar cupo de clase1 con una reserva mock + ajustar cupo_max=1 ──

CREATE OR REPLACE FUNCTION pg_temp._llenar_cupo()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE clases SET cupo_max = 1 WHERE id = (SELECT clase1_id FROM _tst_ctx);
  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, clase_id, notas
  )
  SELECT
    c.tenant_id, c.recurso_id, (SELECT mock_id FROM _tst_ctx),
    (c.fecha + c.hora_inicio) AT TIME ZONE timezone_de_sucursal(c.sucursal_id, c.tenant_id),
    (c.fecha + c.hora_inicio) AT TIME ZONE timezone_de_sucursal(c.sucursal_id, c.tenant_id)
      + (c.duracion_minutos || ' minutes')::interval,
    c.duracion_minutos, 0, 'confirmada',
    'TST-LE-' || lpad((floor(random() * 99999))::int::text, 5, '0'),
    c.id, 'mock reserva llenado de cupo'
  FROM clases c WHERE c.id = (SELECT clase1_id FROM _tst_ctx);
END $$;

-- ============================================================================
-- TEST 1 — Anotar (créditos) debita 1 + ledger con lista_espera_id
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._llenar_cupo();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_resp jsonb;
  v_saldo integer;
  v_mov record;
BEGIN
  v_resp := anotar_lista_espera(v_clase);
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT tipo, delta_creditos, lista_espera_id, reserva_id INTO v_mov
  FROM membresia_movimientos
  WHERE membresia_id = v_mem
    AND lista_espera_id = (v_resp->>'lista_espera_id')::uuid;

  IF (v_resp->>'success')::boolean
     AND v_saldo = 4
     AND (v_resp->>'creditos_restantes')::integer = 4
     AND v_mov.tipo = 'debito'
     AND v_mov.delta_creditos = -1
     AND v_mov.lista_espera_id IS NOT NULL
     AND v_mov.reserva_id IS NULL THEN
    INSERT INTO _tst_results VALUES (1, 'Anotar (créditos) debita 1', TRUE,
      'saldo 5→4, mov debito con lista_espera_id, reserva_id NULL');
  ELSE
    INSERT INTO _tst_results VALUES (1, 'Anotar (créditos) debita 1', FALSE,
      format('saldo=%s creditos_resp=%s mov=%s/%s le_id=%s res_id=%s',
        v_saldo, v_resp->>'creditos_restantes', v_mov.tipo, v_mov.delta_creditos,
        v_mov.lista_espera_id, v_mov.reserva_id));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (1, 'Anotar (créditos) debita 1', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 2 — SIN_CREDITOS bloquea anotar (saldo 0)
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 0, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._llenar_cupo();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_err text;
  v_saldo integer;
  v_entradas integer;
  v_movs integer;
BEGIN
  BEGIN
    PERFORM anotar_lista_espera(v_clase);
    INSERT INTO _tst_results VALUES (2, 'SIN_CREDITOS bloquea anotar', FALSE,
      'no falló (esperado SIN_CREDITOS)');
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT count(*) INTO v_entradas FROM lista_espera
  WHERE clase_id = v_clase AND usuario_id = (SELECT socio_id FROM _tst_ctx);
  SELECT count(*) INTO v_movs FROM membresia_movimientos
  WHERE membresia_id = v_mem
    AND id NOT IN (SELECT id FROM _tst_baseline_movimientos);

  IF v_err LIKE 'SIN_CREDITOS%' AND v_saldo = 0 AND v_entradas = 0 AND v_movs = 0 THEN
    INSERT INTO _tst_results VALUES (2, 'SIN_CREDITOS bloquea anotar', TRUE,
      'err=SIN_CREDITOS, sin entrada, sin movimiento, saldo intacto');
  ELSE
    INSERT INTO _tst_results VALUES (2, 'SIN_CREDITOS bloquea anotar', FALSE,
      format('err=%s saldo=%s entradas=%s movs=%s', v_err, v_saldo, v_entradas, v_movs));
  END IF;
END $t$;

-- ============================================================================
-- TEST 3 — MEMBRESIA_VENCIDA bloquea anotar
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = now() - interval '1 day'
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._llenar_cupo();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_err text;
  v_saldo integer;
  v_entradas integer;
BEGIN
  BEGIN
    PERFORM anotar_lista_espera(v_clase);
    INSERT INTO _tst_results VALUES (3, 'MEMBRESIA_VENCIDA bloquea anotar', FALSE,
      'no falló (esperado MEMBRESIA_VENCIDA)');
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT count(*) INTO v_entradas FROM lista_espera
  WHERE clase_id = v_clase AND usuario_id = (SELECT socio_id FROM _tst_ctx);

  IF v_err LIKE 'MEMBRESIA_VENCIDA%' AND v_saldo = 5 AND v_entradas = 0 THEN
    INSERT INTO _tst_results VALUES (3, 'MEMBRESIA_VENCIDA bloquea anotar', TRUE,
      'err=MEMBRESIA_VENCIDA, sin entrada, saldo intacto');
  ELSE
    INSERT INTO _tst_results VALUES (3, 'MEMBRESIA_VENCIDA bloquea anotar', FALSE,
      format('err=%s saldo=%s entradas=%s', v_err, v_saldo, v_entradas));
  END IF;
END $t$;

-- ============================================================================
-- TEST 4 — Tier tipo=tiempo → no debita (entra sin movimiento)
-- ============================================================================
SELECT pg_temp._reset();
-- Estado natural: tier tipo='tiempo'. No tocamos creditos_restantes (NULL).
SELECT pg_temp._llenar_cupo();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_resp jsonb;
  v_movs integer;
  v_entradas integer;
BEGIN
  v_resp := anotar_lista_espera(v_clase);
  SELECT count(*) INTO v_entradas FROM lista_espera
  WHERE id = (v_resp->>'lista_espera_id')::uuid AND status = 'esperando';
  SELECT count(*) INTO v_movs FROM membresia_movimientos
  WHERE lista_espera_id = (v_resp->>'lista_espera_id')::uuid;

  IF (v_resp->>'success')::boolean AND v_entradas = 1 AND v_movs = 0
     AND v_resp->>'creditos_restantes' IS NULL THEN
    INSERT INTO _tst_results VALUES (4, 'Tier tiempo no debita', TRUE,
      'entrada creada, 0 movimientos, creditos_restantes=null');
  ELSE
    INSERT INTO _tst_results VALUES (4, 'Tier tiempo no debita', FALSE,
      format('success=%s entradas=%s movs=%s creditos_resp=%s',
        v_resp->>'success', v_entradas, v_movs, v_resp->>'creditos_restantes'));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (4, 'Tier tiempo no debita', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 5 — Salir a tiempo devuelve 1
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._llenar_cupo();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_resp_anotar jsonb;
  v_resp_salir jsonb;
  v_le_id uuid;
  v_saldo integer;
  v_debitos integer;
  v_devoluciones integer;
  v_status text;
BEGIN
  v_resp_anotar := anotar_lista_espera(v_clase);   -- 5 → 4
  v_le_id := (v_resp_anotar->>'lista_espera_id')::uuid;
  v_resp_salir := salir_lista_espera(v_clase);     -- 4 → 5

  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT status INTO v_status FROM lista_espera WHERE id = v_le_id;
  SELECT count(*) FILTER (WHERE tipo='debito'),
         count(*) FILTER (WHERE tipo='devolucion')
  INTO v_debitos, v_devoluciones
  FROM membresia_movimientos WHERE lista_espera_id = v_le_id;

  IF (v_resp_salir->>'success')::boolean
     AND (v_resp_salir->>'devuelto')::boolean
     AND (v_resp_salir->>'creditos_restantes')::integer = 5
     AND v_saldo = 5
     AND v_status = 'cancelado'
     AND v_debitos = 1
     AND v_devoluciones = 1 THEN
    INSERT INTO _tst_results VALUES (5, 'Salir a tiempo devuelve 1', TRUE,
      'saldo 5→4→5, status=cancelado, 1 debito + 1 devolucion');
  ELSE
    INSERT INTO _tst_results VALUES (5, 'Salir a tiempo devuelve 1', FALSE,
      format('devuelto=%s saldo=%s status=%s debs=%s devs=%s',
        v_resp_salir->>'devuelto', v_saldo, v_status, v_debitos, v_devoluciones));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (5, 'Salir a tiempo devuelve 1', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 6 — Salir doble: 2da NO_EN_LISTA, sin doble-refund
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._llenar_cupo();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_resp_anotar jsonb;
  v_le_id uuid;
  v_err text;
  v_saldo integer;
  v_devoluciones integer;
BEGIN
  v_resp_anotar := anotar_lista_espera(v_clase);
  v_le_id := (v_resp_anotar->>'lista_espera_id')::uuid;
  PERFORM salir_lista_espera(v_clase);

  BEGIN
    PERFORM salir_lista_espera(v_clase);
    INSERT INTO _tst_results VALUES (6, 'Salir doble protegido', FALSE,
      '2da salida no falló (esperado NO_EN_LISTA)');
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT count(*) INTO v_devoluciones FROM membresia_movimientos
  WHERE lista_espera_id = v_le_id AND tipo = 'devolucion';

  IF v_err LIKE 'NO_EN_LISTA%' AND v_saldo = 5 AND v_devoluciones = 1 THEN
    INSERT INTO _tst_results VALUES (6, 'Salir doble protegido', TRUE,
      'err=NO_EN_LISTA, saldo=5, 1 sola devolución');
  ELSE
    INSERT INTO _tst_results VALUES (6, 'Salir doble protegido', FALSE,
      format('err=%s saldo=%s devoluciones=%s', v_err, v_saldo, v_devoluciones));
  END IF;
END $t$;

-- ============================================================================
-- TEST 7 — CLASE_PASADA bloquea salir (no refund a destiempo)
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._llenar_cupo();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_resp_anotar jsonb;
  v_le_id uuid;
  v_err text;
  v_saldo integer;
  v_status text;
  v_devoluciones integer;
BEGIN
  v_resp_anotar := anotar_lista_espera(v_clase);   -- 5 → 4 con clase aún futura
  v_le_id := (v_resp_anotar->>'lista_espera_id')::uuid;

  -- Empujar la clase al pasado SIN tocar la entrada. Usamos fecha+hora
  -- "imposible" (1990 + 03:33:33) para no colisionar con el UNIQUE
  -- (tenant, recurso, fecha, hora_inicio) — clases reales viven en fechas
  -- recientes con horas en punto.
  UPDATE clases SET fecha = '1990-01-01', hora_inicio = '03:33:33'
  WHERE id = v_clase;

  BEGIN
    PERFORM salir_lista_espera(v_clase);
    INSERT INTO _tst_results VALUES (7, 'CLASE_PASADA bloquea salir', FALSE,
      'salir no falló (esperado CLASE_PASADA)');
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT status INTO v_status FROM lista_espera WHERE id = v_le_id;
  SELECT count(*) INTO v_devoluciones FROM membresia_movimientos
  WHERE lista_espera_id = v_le_id AND tipo = 'devolucion';

  IF v_err LIKE 'CLASE_PASADA%'
     AND v_saldo = 4
     AND v_status = 'esperando'
     AND v_devoluciones = 0 THEN
    INSERT INTO _tst_results VALUES (7, 'CLASE_PASADA bloquea salir', TRUE,
      'err=CLASE_PASADA, saldo sigue 4, sin devolución (la deja expirar)');
  ELSE
    INSERT INTO _tst_results VALUES (7, 'CLASE_PASADA bloquea salir', FALSE,
      format('err=%s saldo=%s status=%s devoluciones=%s',
        v_err, v_saldo, v_status, v_devoluciones));
  END IF;
END $t$;

-- ============================================================================
-- TEST 8 — Admin cancela clase → trigger devuelve crédito a esperando
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._llenar_cupo();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_resp_anotar jsonb;
  v_le_id uuid;
  v_saldo integer;
  v_status text;
  v_devoluciones integer;
BEGIN
  v_resp_anotar := anotar_lista_espera(v_clase);   -- 5 → 4
  v_le_id := (v_resp_anotar->>'lista_espera_id')::uuid;

  -- Admin (postgres / sesión sin auth) cancela la clase → dispara trigger
  PERFORM pg_temp._as(NULL);
  UPDATE clases SET status = 'cancelada' WHERE id = v_clase;
  PERFORM pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT status INTO v_status FROM lista_espera WHERE id = v_le_id;
  SELECT count(*) INTO v_devoluciones FROM membresia_movimientos
  WHERE lista_espera_id = v_le_id AND tipo = 'devolucion';

  IF v_status = 'cancelado' AND v_saldo = 5 AND v_devoluciones = 1 THEN
    INSERT INTO _tst_results VALUES (8, 'Admin cancela clase → trigger refunda', TRUE,
      'status=cancelado, saldo 4→5, 1 devolución');
  ELSE
    INSERT INTO _tst_results VALUES (8, 'Admin cancela clase → trigger refunda', FALSE,
      format('status=%s saldo=%s devoluciones=%s', v_status, v_saldo, v_devoluciones));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (8, 'Admin cancela clase → trigger refunda', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 9 — expirar_listas_espera_vencidas marca 'expirada' + refunda
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._llenar_cupo();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_resp_anotar jsonb;
  v_le_id uuid;
  v_resp_cron jsonb;
  v_saldo integer;
  v_status text;
  v_expirado_at timestamptz;
  v_devoluciones integer;
BEGIN
  v_resp_anotar := anotar_lista_espera(v_clase);   -- 5 → 4
  v_le_id := (v_resp_anotar->>'lista_espera_id')::uuid;

  -- Empujar clase al pasado (fecha+hora "imposible" para evitar colisión
  -- con el UNIQUE clases_unique_slot — ver comentario en test 7).
  UPDATE clases SET fecha = '1990-01-01', hora_inicio = '03:33:33'
  WHERE id = v_clase;

  PERFORM pg_temp._as(NULL);
  v_resp_cron := expirar_listas_espera_vencidas();
  PERFORM pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT status, expirado_at INTO v_status, v_expirado_at FROM lista_espera WHERE id = v_le_id;
  SELECT count(*) INTO v_devoluciones FROM membresia_movimientos
  WHERE lista_espera_id = v_le_id AND tipo = 'devolucion';

  IF v_status = 'expirada'
     AND v_expirado_at IS NOT NULL
     AND v_saldo = 5
     AND v_devoluciones = 1
     AND (v_resp_cron->>'expiradas')::integer >= 1
     AND (v_resp_cron->>'refundadas')::integer >= 1 THEN
    INSERT INTO _tst_results VALUES (9, 'expirar_listas_espera marca + refunda', TRUE,
      format('status=expirada, saldo 4→5, expiradas=%s refundadas=%s',
        v_resp_cron->>'expiradas', v_resp_cron->>'refundadas'));
  ELSE
    INSERT INTO _tst_results VALUES (9, 'expirar_listas_espera marca + refunda', FALSE,
      format('status=%s expirado_at=%s saldo=%s devs=%s cron=%s',
        v_status, v_expirado_at, v_saldo, v_devoluciones, v_resp_cron));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (9, 'expirar_listas_espera marca + refunda', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 10 — expirar idempotente (2da corrida = 0 efectos sobre esa entrada)
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._llenar_cupo();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_resp_anotar jsonb;
  v_le_id uuid;
  v_resp_cron1 jsonb;
  v_resp_cron2 jsonb;
  v_saldo integer;
  v_devoluciones integer;
BEGIN
  v_resp_anotar := anotar_lista_espera(v_clase);
  v_le_id := (v_resp_anotar->>'lista_espera_id')::uuid;
  -- Empujar al pasado (ver comentario en test 7).
  UPDATE clases SET fecha = '1990-01-01', hora_inicio = '03:33:33'
  WHERE id = v_clase;

  PERFORM pg_temp._as(NULL);
  v_resp_cron1 := expirar_listas_espera_vencidas();
  v_resp_cron2 := expirar_listas_espera_vencidas();
  PERFORM pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT count(*) INTO v_devoluciones FROM membresia_movimientos
  WHERE lista_espera_id = v_le_id AND tipo = 'devolucion';

  -- 2da corrida no debe sumar ni expiradas ni refundadas sobre esta entrada.
  -- (Otras entradas del tenant podrían contar; el chequeo clave es saldo + devs=1.)
  IF v_saldo = 5 AND v_devoluciones = 1 THEN
    INSERT INTO _tst_results VALUES (10, 'expirar idempotente', TRUE,
      format('1ra: %s, 2da: %s — saldo=5 y 1 sola devolución',
        v_resp_cron1, v_resp_cron2));
  ELSE
    INSERT INTO _tst_results VALUES (10, 'expirar idempotente', FALSE,
      format('saldo=%s devoluciones=%s — esperado 5 y 1',
        v_saldo, v_devoluciones));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (10, 'expirar idempotente', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 11 — Cancelar reserva promovida A TIEMPO → fallback devuelve crédito
-- ============================================================================
-- Flujo:
--   1. David se anota (debita; 5 → 4; movimiento con lista_espera_id=LE)
--   2. David se vuelve admin → cancela la reserva del mock → trigger
--      reservas_promover_lista_espera dispara → _promover_entrada crea
--      reserva nueva para David (SIN movimiento debito propio) y marca LE
--      como 'promovido' con reserva_id=R_nueva.
--   3. David (aún admin/dueño) cancela R_nueva con ventana en regla →
--      cancelar_reserva_atomic busca débito por reserva_id (no encuentra) →
--      fallback busca por lista_espera origen → encuentra el débito en LE →
--      devuelve 1 crédito (4 → 5).
-- Veredicto: saldo final = 5, motivo='a_tiempo', 1 debito + 1 devolucion en
-- el ledger por lista_espera_id (la devolución también con reserva_id=R_nueva).
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mock_mem_id FROM _tst_ctx);
SELECT pg_temp._llenar_cupo();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_resp_anotar jsonb;
  v_le_id uuid;
  v_reserva_mock_id uuid;
  v_reserva_promovida_id uuid;
  v_resp_cancel jsonb;
  v_saldo_david integer;
  v_status_entrada text;
  v_status_reserva text;
  v_debitos integer;
  v_devoluciones integer;
  v_devolucion record;
BEGIN
  -- 1. David se anota (5 → 4)
  v_resp_anotar := anotar_lista_espera(v_clase);
  v_le_id := (v_resp_anotar->>'lista_espera_id')::uuid;

  -- 2. David admin → cancela mock → trigger promueve a David
  UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT socio_id FROM _tst_ctx);
  SELECT id INTO v_reserva_mock_id FROM reservas
  WHERE clase_id = v_clase AND usuario_id = (SELECT mock_id FROM _tst_ctx)
    AND status = 'confirmada' LIMIT 1;
  PERFORM cancelar_reserva_atomic(v_reserva_mock_id, 'test 11 disparar promoción');

  SELECT id INTO v_reserva_promovida_id FROM reservas
  WHERE clase_id = v_clase AND usuario_id = (SELECT socio_id FROM _tst_ctx)
    AND status = 'confirmada' LIMIT 1;

  -- Confirmar que la entrada quedó 'promovido' con reserva_id seteada
  SELECT status INTO v_status_entrada FROM lista_espera WHERE id = v_le_id;
  IF v_status_entrada <> 'promovido' OR v_reserva_promovida_id IS NULL THEN
    INSERT INTO _tst_results VALUES (11, 'Promovida cancela a tiempo → fallback devuelve', FALSE,
      format('setup falló: status_entrada=%s reserva_promovida=%s',
        v_status_entrada, v_reserva_promovida_id));
    RETURN;
  END IF;

  -- Revertir a 'miembro' antes del paso 3: cancelar_reserva_atomic solo
  -- entra al bloque de devolución si v_owner_rol='miembro'. David sigue
  -- siendo el dueño → pasa la autorización sin admin.
  UPDATE usuarios SET rol = 'miembro' WHERE id = (SELECT socio_id FROM _tst_ctx);

  -- 3. David cancela su reserva promovida (clase aún > 25h, ventana=4h default)
  v_resp_cancel := cancelar_reserva_atomic(v_reserva_promovida_id, 'test 11 cancelar promovida');

  SELECT creditos_restantes INTO v_saldo_david FROM membresias WHERE id = v_mem;
  SELECT status INTO v_status_reserva FROM reservas WHERE id = v_reserva_promovida_id;
  SELECT count(*) FILTER (WHERE tipo='debito'),
         count(*) FILTER (WHERE tipo='devolucion')
  INTO v_debitos, v_devoluciones
  FROM membresia_movimientos WHERE lista_espera_id = v_le_id;

  SELECT tipo, delta_creditos, reserva_id, lista_espera_id INTO v_devolucion
  FROM membresia_movimientos
  WHERE membresia_id = v_mem AND tipo = 'devolucion'
    AND lista_espera_id = v_le_id;

  IF (v_resp_cancel->>'success')::boolean
     AND (v_resp_cancel->>'devuelto')::boolean
     AND (v_resp_cancel->>'devolucion_motivo') = 'a_tiempo'
     AND (v_resp_cancel->>'creditos_restantes')::integer = 5
     AND v_saldo_david = 5
     AND v_status_reserva = 'cancelada'
     AND v_debitos = 1
     AND v_devoluciones = 1
     AND v_devolucion.reserva_id = v_reserva_promovida_id
     AND v_devolucion.lista_espera_id = v_le_id THEN
    INSERT INTO _tst_results VALUES (11, 'Promovida cancela a tiempo → fallback devuelve', TRUE,
      'saldo 4→5, motivo=a_tiempo, devolución con reserva_id Y lista_espera_id');
  ELSE
    INSERT INTO _tst_results VALUES (11, 'Promovida cancela a tiempo → fallback devuelve', FALSE,
      format('devuelto=%s motivo=%s saldo=%s status_res=%s debs=%s devs=%s dev.res=%s dev.le=%s',
        v_resp_cancel->>'devuelto', v_resp_cancel->>'devolucion_motivo',
        v_saldo_david, v_status_reserva, v_debitos, v_devoluciones,
        v_devolucion.reserva_id, v_devolucion.lista_espera_id));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (11, 'Promovida cancela a tiempo → fallback devuelve', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 12 — Balance global: anotar + salir = neto 0 (ledger cuadra)
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 7, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
SELECT pg_temp._llenar_cupo();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_resp_anotar jsonb;
  v_le_id uuid;
  v_saldo_inicial integer := 7;
  v_saldo_final integer;
  v_suma_deltas integer;
BEGIN
  v_resp_anotar := anotar_lista_espera(v_clase);
  v_le_id := (v_resp_anotar->>'lista_espera_id')::uuid;
  PERFORM salir_lista_espera(v_clase);

  SELECT creditos_restantes INTO v_saldo_final FROM membresias WHERE id = v_mem;
  SELECT COALESCE(sum(delta_creditos), 0) INTO v_suma_deltas
  FROM membresia_movimientos WHERE lista_espera_id = v_le_id;

  IF v_saldo_final = v_saldo_inicial AND v_suma_deltas = 0 THEN
    INSERT INTO _tst_results VALUES (12, 'Balance global anotar+salir = 0', TRUE,
      format('saldo %s → %s, suma deltas ledger = 0',
        v_saldo_inicial, v_saldo_final));
  ELSE
    INSERT INTO _tst_results VALUES (12, 'Balance global anotar+salir = 0', FALSE,
      format('saldo inicial=%s final=%s suma_deltas=%s',
        v_saldo_inicial, v_saldo_final, v_suma_deltas));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (12, 'Balance global anotar+salir = 0', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 13 — Cancelar reserva promovida TARDE → no devuelve (motivo='tarde')
-- ============================================================================
-- Mismo flujo que 11, pero con ventana 720h (30 días) → siempre tarde. La
-- reserva se cancela igual (la ventana no bloquea), pero NO se devuelve.
-- Confirma que la lógica de ventana aplica también al camino del fallback.
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mock_mem_id FROM _tst_ctx);
UPDATE tenants
SET config = jsonb_set(config, '{reserva,cancelacion_min_horas}', '720')
WHERE id = (SELECT tenant_id FROM _tst_ctx);
SELECT pg_temp._llenar_cupo();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_resp_anotar jsonb;
  v_le_id uuid;
  v_reserva_mock_id uuid;
  v_reserva_promovida_id uuid;
  v_resp_cancel jsonb;
  v_saldo_david integer;
  v_status_reserva text;
  v_devoluciones integer;
BEGIN
  v_resp_anotar := anotar_lista_espera(v_clase);   -- 5 → 4
  v_le_id := (v_resp_anotar->>'lista_espera_id')::uuid;

  UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT socio_id FROM _tst_ctx);
  SELECT id INTO v_reserva_mock_id FROM reservas
  WHERE clase_id = v_clase AND usuario_id = (SELECT mock_id FROM _tst_ctx)
    AND status = 'confirmada' LIMIT 1;
  PERFORM cancelar_reserva_atomic(v_reserva_mock_id, 'test 13 promover');

  SELECT id INTO v_reserva_promovida_id FROM reservas
  WHERE clase_id = v_clase AND usuario_id = (SELECT socio_id FROM _tst_ctx)
    AND status = 'confirmada' LIMIT 1;

  -- Revertir a 'miembro' (ver comentario en test 11)
  UPDATE usuarios SET rol = 'miembro' WHERE id = (SELECT socio_id FROM _tst_ctx);

  v_resp_cancel := cancelar_reserva_atomic(v_reserva_promovida_id, 'test 13 cancelar tarde');

  SELECT creditos_restantes INTO v_saldo_david FROM membresias WHERE id = v_mem;
  SELECT status INTO v_status_reserva FROM reservas WHERE id = v_reserva_promovida_id;
  SELECT count(*) INTO v_devoluciones FROM membresia_movimientos
  WHERE lista_espera_id = v_le_id AND tipo = 'devolucion';

  IF (v_resp_cancel->>'success')::boolean
     AND NOT (v_resp_cancel->>'devuelto')::boolean
     AND (v_resp_cancel->>'devolucion_motivo') = 'tarde'
     AND v_saldo_david = 4
     AND v_status_reserva = 'cancelada'
     AND v_devoluciones = 0 THEN
    INSERT INTO _tst_results VALUES (13, 'Promovida cancela TARDE → no devuelve', TRUE,
      'reserva cancelada, motivo=tarde, saldo sigue 4, sin devolución');
  ELSE
    INSERT INTO _tst_results VALUES (13, 'Promovida cancela TARDE → no devuelve', FALSE,
      format('devuelto=%s motivo=%s saldo=%s status=%s devs=%s',
        v_resp_cancel->>'devuelto', v_resp_cancel->>'devolucion_motivo',
        v_saldo_david, v_status_reserva, v_devoluciones));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (13, 'Promovida cancela TARDE → no devuelve', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 14 — Doble cancelación de reserva promovida → 1 sola devolución
-- ============================================================================
-- 1ra cancelación a tiempo: fallback devuelve (4→5, 1 devolucion con ambas
-- claves). 2da cancelación de la misma reserva: RESERVA_NO_CANCELABLE (status
-- ya = 'cancelada'). Ledger sigue con 1 sola devolución. Anti-doble probado.
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mock_mem_id FROM _tst_ctx);
SELECT pg_temp._llenar_cupo();
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_resp_anotar jsonb;
  v_le_id uuid;
  v_reserva_mock_id uuid;
  v_reserva_promovida_id uuid;
  v_err text;
  v_saldo_david integer;
  v_devoluciones integer;
BEGIN
  v_resp_anotar := anotar_lista_espera(v_clase);   -- 5 → 4
  v_le_id := (v_resp_anotar->>'lista_espera_id')::uuid;

  UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT socio_id FROM _tst_ctx);
  SELECT id INTO v_reserva_mock_id FROM reservas
  WHERE clase_id = v_clase AND usuario_id = (SELECT mock_id FROM _tst_ctx)
    AND status = 'confirmada' LIMIT 1;
  PERFORM cancelar_reserva_atomic(v_reserva_mock_id, 'test 14 promover');

  SELECT id INTO v_reserva_promovida_id FROM reservas
  WHERE clase_id = v_clase AND usuario_id = (SELECT socio_id FROM _tst_ctx)
    AND status = 'confirmada' LIMIT 1;

  -- Revertir a 'miembro' (ver comentario en test 11)
  UPDATE usuarios SET rol = 'miembro' WHERE id = (SELECT socio_id FROM _tst_ctx);

  -- 1ra cancelación a tiempo → fallback devuelve (4 → 5)
  PERFORM cancelar_reserva_atomic(v_reserva_promovida_id, 'test 14 1ra cancel');

  -- 2da cancelación de la misma reserva → debe fallar RESERVA_NO_CANCELABLE
  BEGIN
    PERFORM cancelar_reserva_atomic(v_reserva_promovida_id, 'test 14 2da cancel');
    INSERT INTO _tst_results VALUES (14, 'Doble cancelación promovida → 1 sola devolución', FALSE,
      '2da cancelación no falló (esperado RESERVA_NO_CANCELABLE)');
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  SELECT creditos_restantes INTO v_saldo_david FROM membresias WHERE id = v_mem;
  SELECT count(*) INTO v_devoluciones FROM membresia_movimientos
  WHERE lista_espera_id = v_le_id AND tipo = 'devolucion';

  IF v_err LIKE 'RESERVA_NO_CANCELABLE%'
     AND v_saldo_david = 5
     AND v_devoluciones = 1 THEN
    INSERT INTO _tst_results VALUES (14, 'Doble cancelación promovida → 1 sola devolución', TRUE,
      'err=RESERVA_NO_CANCELABLE, saldo=5, 1 sola devolución');
  ELSE
    INSERT INTO _tst_results VALUES (14, 'Doble cancelación promovida → 1 sola devolución', FALSE,
      format('err=%s saldo=%s devoluciones=%s', v_err, v_saldo_david, v_devoluciones));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (14, 'Doble cancelación promovida → 1 sola devolución', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 15 — Reserva NORMAL: fallback NO se activa (lista_espera_id IS NULL)
-- ============================================================================
-- Garantía explícita de que el fallback agregado en cancelar_reserva_atomic
-- (sección H de la migración) NO contamina el camino feliz. David reserva
-- directo (sin pasar por lista de espera) → reservar_clase_atomic debita por
-- reserva_id. Cancela a tiempo → cancelar_reserva_atomic encuentra el débito
-- en el primer count (por reserva_id) → fallback NUNCA corre → la devolución
-- queda con lista_espera_id IS NULL (no se cruzó con ninguna entrada de cola).
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
-- NO _llenar_cupo() — clase queda con cupo libre para que David pueda
-- reservar directo en lugar de anotarse en lista.
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_resp_reservar jsonb;
  v_resp_cancel jsonb;
  v_saldo integer;
  v_devolucion record;
BEGIN
  v_resp_reservar := reservar_clase_atomic(v_clase, 0, NULL);   -- 5 → 4
  v_resp_cancel := cancelar_reserva_atomic(
    (v_resp_reservar->>'reserva_id')::uuid, 'test 15 normal a tiempo'
  );                                                             -- 4 → 5

  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT tipo, delta_creditos, reserva_id, lista_espera_id INTO v_devolucion
  FROM membresia_movimientos
  WHERE membresia_id = v_mem
    AND reserva_id = (v_resp_reservar->>'reserva_id')::uuid
    AND tipo = 'devolucion';

  IF (v_resp_cancel->>'success')::boolean
     AND (v_resp_cancel->>'devuelto')::boolean
     AND (v_resp_cancel->>'devolucion_motivo') = 'a_tiempo'
     AND v_saldo = 5
     AND v_devolucion.reserva_id = (v_resp_reservar->>'reserva_id')::uuid
     AND v_devolucion.lista_espera_id IS NULL THEN
    INSERT INTO _tst_results VALUES (15, 'Reserva NORMAL: fallback NO se activa', TRUE,
      'saldo 4→5, devolución con reserva_id y lista_espera_id IS NULL');
  ELSE
    INSERT INTO _tst_results VALUES (15, 'Reserva NORMAL: fallback NO se activa', FALSE,
      format('devuelto=%s motivo=%s saldo=%s dev.res=%s dev.le=%s',
        v_resp_cancel->>'devuelto', v_resp_cancel->>'devolucion_motivo',
        v_saldo, v_devolucion.reserva_id, v_devolucion.lista_espera_id));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (15, 'Reserva NORMAL: fallback NO se activa', FALSE,
    'error inesperado: ' || SQLERRM);
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
