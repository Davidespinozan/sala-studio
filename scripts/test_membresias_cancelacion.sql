-- ============================================================================
-- TESTS — Cancelación + devolución de crédito (Fase 2B)
-- ============================================================================
-- USO: pegar este bloque entero en el SQL Editor de Supabase y ejecutar.
--      Está envuelto en BEGIN/ROLLBACK → NO persiste ningún cambio.
--      El veredicto sale como TABLA al final (pestaña Results).
--
-- ESTRATEGIA — igual que test_membresias_gate.sql: snapshots de baseline al
-- inicio + helper _reset() entre tests. NO savepoints (rollback to savepoint
-- también revertiría los INSERTs a _tst_results).
--
-- Test 6 (admin cancela reserva de otro socio) requiere un 2do usuario.
-- Usamos un mock @example.com (maria.garcia, que tiene tier 'pro') como
-- "víctima" del admin. No tiene auth_id, así que no se lo puede impersonar —
-- las reservas y movimientos en su nombre se insertan directamente.
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
  clase2_id uuid,
  tenant_id uuid,
  mock_id uuid,        -- usuario mock para test 6
  mock_mem_id uuid     -- su membresía
);

-- ── setup: localizar entidades ─────────────────────────────────────────────

DO $ctx$
DECLARE
  v_socio_id uuid;
  v_socio_auth_id uuid;
  v_tier_id uuid;
  v_mem_id uuid;
  v_clase1 uuid;
  v_clase2 uuid;
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

  -- Mock para test 6: usuario distinto con membresía activa en el MISMO tier.
  -- Eso facilita: mutamos el tier 'pro' a creditos una sola vez y afecta a ambos.
  SELECT u.id, m.id INTO v_mock_id, v_mock_mem_id
  FROM usuarios u
  JOIN membresias m ON m.usuario_id = u.id AND m.status = 'activa'
  WHERE u.tenant_id = v_tenant
    AND u.rol = 'miembro'
    AND u.id <> v_socio_id
    AND m.tier_id = v_tier_id
  LIMIT 1;

  IF v_mock_id IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: no se encontró 2do socio con mismo tier para test 6';
  END IF;

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
    AND (
      SELECT count(*) FROM reservas r
      WHERE r.clase_id = c.id AND r.status IN ('confirmada','completada')
    ) < c.cupo_max - 2
  ORDER BY (c.fecha + c.hora_inicio) ASC
  LIMIT 1;

  IF v_clase1 IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: no se encontró clase futura con 2+ cupos libres';
  END IF;

  SELECT c.id INTO v_clase2
  FROM clases c
  WHERE c.tenant_id = v_tenant
    AND c.id <> v_clase1
    AND c.status = 'programada'
    AND (c.fecha + c.hora_inicio)::timestamp > (now() + interval '25 hours')
    AND NOT EXISTS (
      SELECT 1 FROM reservas r
      WHERE r.clase_id = c.id
        AND r.usuario_id IN (v_socio_id, v_mock_id)
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
    v_socio_id, v_socio_auth_id, v_tier_id, v_mem_id,
    v_clase1, v_clase2, v_tenant, v_mock_id, v_mock_mem_id
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
  SELECT * FROM clases WHERE id IN (
    (SELECT clase1_id FROM _tst_ctx), (SELECT clase2_id FROM _tst_ctx)
  );

CREATE TEMP TABLE _tst_baseline_tenant AS
  SELECT * FROM tenants WHERE id = (SELECT tenant_id FROM _tst_ctx);

CREATE TEMP TABLE _tst_baseline_reservas AS
  SELECT id FROM reservas WHERE clase_id IN (SELECT id FROM _tst_baseline_clase);

CREATE TEMP TABLE _tst_baseline_movimientos AS
  SELECT id FROM membresia_movimientos;

INSERT INTO _tst_results VALUES (
  0, 'SETUP', TRUE,
  format('socio=%s mock=%s mem=%s mock_mem=%s clase1=%s clase2=%s baseline_reservas=%s baseline_movs=%s',
    (SELECT socio_id FROM _tst_ctx),
    (SELECT mock_id FROM _tst_ctx),
    (SELECT mem_id FROM _tst_ctx),
    (SELECT mock_mem_id FROM _tst_ctx),
    (SELECT clase1_id FROM _tst_ctx),
    (SELECT clase2_id FROM _tst_ctx),
    (SELECT count(*) FROM _tst_baseline_reservas),
    (SELECT count(*) FROM _tst_baseline_movimientos))
);

-- ── _reset() ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pg_temp._reset()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Borrar reservas y movimientos creados durante tests
  DELETE FROM reservas
  WHERE clase_id IN (SELECT id FROM _tst_baseline_clase)
    AND id NOT IN (SELECT id FROM _tst_baseline_reservas);

  DELETE FROM membresia_movimientos
  WHERE id NOT IN (SELECT id FROM _tst_baseline_movimientos);

  -- Restaurar usuarios (David + mock)
  UPDATE usuarios u
  SET rol = b.rol,
      status = b.status,
      bloqueado_hasta = b.bloqueado_hasta,
      membresia_activa_id = b.membresia_activa_id,
      membresia_tier = b.membresia_tier
  FROM _tst_baseline_user b
  WHERE u.id = b.id;

  -- Restaurar membresías
  UPDATE membresias m
  SET status = b.status,
      periodo_actual_inicio = b.periodo_actual_inicio,
      periodo_actual_fin = b.periodo_actual_fin,
      creditos_restantes = b.creditos_restantes
  FROM _tst_baseline_mem b
  WHERE m.id = b.id;

  -- Restaurar tier
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

  -- Restaurar config del tenant
  UPDATE tenants t
  SET config = b.config
  FROM _tst_baseline_tenant b
  WHERE t.id = b.id;
END $$;

-- ============================================================================
-- TEST 1 — Cancelar a tiempo (créditos): devuelve 1, motivo 'a_tiempo'
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
  v_reserva jsonb;
  v_cancel jsonb;
  v_saldo integer;
  v_devolucion record;
BEGIN
  -- Reservar (debita 1: 5 → 4)
  v_reserva := reservar_clase_atomic(v_clase, 0, NULL);

  -- Cancelar a tiempo (ventana default 4h; la clase es a > 25h)
  v_cancel := cancelar_reserva_atomic((v_reserva->>'reserva_id')::uuid, 'test');

  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT tipo, delta_creditos, reserva_id INTO v_devolucion
  FROM membresia_movimientos
  WHERE membresia_id = v_mem
    AND reserva_id = (v_reserva->>'reserva_id')::uuid
    AND tipo = 'devolucion';

  IF (v_cancel->>'success')::boolean
     AND (v_cancel->>'devuelto')::boolean
     AND (v_cancel->>'devolucion_motivo') = 'a_tiempo'
     AND v_saldo = 5
     AND (v_cancel->>'creditos_restantes')::integer = 5
     AND v_devolucion.tipo = 'devolucion'
     AND v_devolucion.delta_creditos = 1 THEN
    INSERT INTO _tst_results VALUES (1, 'Cancelar a tiempo (créditos) devuelve 1', TRUE,
      format('saldo 4→5, motivo=a_tiempo, movimiento devolucion ok'));
  ELSE
    INSERT INTO _tst_results VALUES (1, 'Cancelar a tiempo (créditos) devuelve 1', FALSE,
      format('devuelto=%s motivo=%s saldo=%s mov=%s/%s',
        v_cancel->>'devuelto', v_cancel->>'devolucion_motivo', v_saldo,
        v_devolucion.tipo, v_devolucion.delta_creditos));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (1, 'Cancelar a tiempo (créditos) devuelve 1', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 2 — Cancelar TARDE (créditos): cancela pero NO devuelve, motivo 'tarde'
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);
-- Forzar "tarde": ventana de 720h (30 días) — más larga que la anticipación
-- de la clase, así llegamos tarde aunque la clase esté en 25+h.
UPDATE tenants
SET config = jsonb_set(config, '{reserva,cancelacion_min_horas}', '720')
WHERE id = (SELECT tenant_id FROM _tst_ctx);
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_reserva jsonb;
  v_cancel jsonb;
  v_saldo integer;
  v_devoluciones integer;
  v_status text;
BEGIN
  v_reserva := reservar_clase_atomic(v_clase, 0, NULL);  -- saldo 5 → 4
  v_cancel := cancelar_reserva_atomic((v_reserva->>'reserva_id')::uuid, 'test');

  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT count(*) INTO v_devoluciones FROM membresia_movimientos
  WHERE reserva_id = (v_reserva->>'reserva_id')::uuid AND tipo = 'devolucion';
  SELECT status INTO v_status FROM reservas WHERE id = (v_reserva->>'reserva_id')::uuid;

  IF (v_cancel->>'success')::boolean
     AND NOT (v_cancel->>'devuelto')::boolean
     AND (v_cancel->>'devolucion_motivo') = 'tarde'
     AND v_saldo = 4
     AND v_devoluciones = 0
     AND v_status = 'cancelada' THEN
    INSERT INTO _tst_results VALUES (2, 'Cancelar tarde no devuelve', TRUE,
      'reserva cancelada, motivo=tarde, saldo sigue 4, sin movimiento devolucion');
  ELSE
    INSERT INTO _tst_results VALUES (2, 'Cancelar tarde no devuelve', FALSE,
      format('devuelto=%s motivo=%s saldo=%s devoluciones=%s status=%s',
        v_cancel->>'devuelto', v_cancel->>'devolucion_motivo', v_saldo,
        v_devoluciones, v_status));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (2, 'Cancelar tarde no devuelve', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 3 — Cancelar tipo tiempo: cancela, sin movimiento, motivo 'sin_credito'
-- ============================================================================
SELECT pg_temp._reset();
-- Estado natural: tier tipo='tiempo', creditos_restantes=NULL.
SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_clase uuid := (SELECT clase1_id FROM _tst_ctx);
  v_mem uuid := (SELECT mem_id FROM _tst_ctx);
  v_reserva jsonb;
  v_cancel jsonb;
  v_movs integer;
BEGIN
  v_reserva := reservar_clase_atomic(v_clase, 0, NULL);  -- tipo=tiempo: no debita
  v_cancel := cancelar_reserva_atomic((v_reserva->>'reserva_id')::uuid, 'test');

  SELECT count(*) INTO v_movs FROM membresia_movimientos
  WHERE reserva_id = (v_reserva->>'reserva_id')::uuid;

  IF (v_cancel->>'success')::boolean
     AND NOT (v_cancel->>'devuelto')::boolean
     AND (v_cancel->>'devolucion_motivo') = 'sin_credito'
     AND v_movs = 0 THEN
    INSERT INTO _tst_results VALUES (3, 'Cancelar tipo tiempo sin movimiento', TRUE,
      'tipo=tiempo cancela, motivo=sin_credito, 0 movimientos');
  ELSE
    INSERT INTO _tst_results VALUES (3, 'Cancelar tipo tiempo sin movimiento', FALSE,
      format('devuelto=%s motivo=%s movs=%s',
        v_cancel->>'devuelto', v_cancel->>'devolucion_motivo', v_movs));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (3, 'Cancelar tipo tiempo sin movimiento', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 4 — Cancelar reserva SIN débito previo (tier=creditos pero sin movimiento)
-- ============================================================================
SELECT pg_temp._reset();
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mem_id FROM _tst_ctx);

-- INSERT directo de reserva (bypaseando reservar_clase_atomic → no escribe
-- movimiento 'debito'). Simula caso "reserva creada por flujo que no debitó".
INSERT INTO reservas (
  tenant_id, recurso_id, usuario_id,
  slot_inicio, slot_fin, duracion_min,
  invitados_count, status, folio, clase_id, notas
)
SELECT
  c.tenant_id, c.recurso_id, (SELECT socio_id FROM _tst_ctx),
  (c.fecha + c.hora_inicio) AT TIME ZONE timezone_de_sucursal(c.sucursal_id, c.tenant_id),
  (c.fecha + c.hora_inicio) AT TIME ZONE timezone_de_sucursal(c.sucursal_id, c.tenant_id)
    + (c.duracion_minutos || ' minutes')::interval,
  c.duracion_minutos, 0, 'confirmada',
  'TST-' || lpad((floor(random() * 999999))::int::text, 6, '0'),
  c.id, 'mock reserva sin débito'
FROM clases c WHERE c.id = (SELECT clase1_id FROM _tst_ctx);

SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_reserva_id uuid;
  v_cancel jsonb;
  v_saldo integer;
BEGIN
  SELECT id INTO v_reserva_id FROM reservas
  WHERE notas = 'mock reserva sin débito'
    AND usuario_id = (SELECT socio_id FROM _tst_ctx)
  ORDER BY created_at DESC LIMIT 1;

  v_cancel := cancelar_reserva_atomic(v_reserva_id, 'test');
  SELECT creditos_restantes INTO v_saldo FROM membresias
  WHERE id = (SELECT mem_id FROM _tst_ctx);

  IF (v_cancel->>'success')::boolean
     AND NOT (v_cancel->>'devuelto')::boolean
     AND (v_cancel->>'devolucion_motivo') = 'sin_credito'
     AND v_saldo = 5 THEN
    INSERT INTO _tst_results VALUES (4, 'Cancelar reserva sin débito previo', TRUE,
      'motivo=sin_credito, saldo intacto (5)');
  ELSE
    INSERT INTO _tst_results VALUES (4, 'Cancelar reserva sin débito previo', FALSE,
      format('devuelto=%s motivo=%s saldo=%s',
        v_cancel->>'devuelto', v_cancel->>'devolucion_motivo', v_saldo));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (4, 'Cancelar reserva sin débito previo', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 5 — Doble cancelación: 2da llamada da RESERVA_NO_CANCELABLE
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
  v_reserva jsonb;
  v_cancel1 jsonb;
  v_err text;
  v_saldo integer;
  v_devoluciones integer;
BEGIN
  v_reserva := reservar_clase_atomic(v_clase, 0, NULL);   -- saldo 5 → 4
  v_cancel1 := cancelar_reserva_atomic((v_reserva->>'reserva_id')::uuid, 'test');  -- devuelve → 5

  -- 2da cancelación: debe fallar con RESERVA_NO_CANCELABLE (ya está cancelada)
  BEGIN
    PERFORM cancelar_reserva_atomic((v_reserva->>'reserva_id')::uuid, 'test 2da');
    INSERT INTO _tst_results VALUES (5, 'Doble cancelación protegida', FALSE,
      '2da cancelación no falló (esperado RESERVA_NO_CANCELABLE)');
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT count(*) INTO v_devoluciones FROM membresia_movimientos
  WHERE reserva_id = (v_reserva->>'reserva_id')::uuid AND tipo = 'devolucion';

  IF v_err LIKE 'RESERVA_NO_CANCELABLE%'
     AND v_saldo = 5
     AND v_devoluciones = 1 THEN
    INSERT INTO _tst_results VALUES (5, 'Doble cancelación protegida', TRUE,
      'err=RESERVA_NO_CANCELABLE, saldo=5, 1 sola devolución');
  ELSE
    INSERT INTO _tst_results VALUES (5, 'Doble cancelación protegida', FALSE,
      format('err=%s saldo=%s devoluciones=%s', v_err, v_saldo, v_devoluciones));
  END IF;
END $t$;

-- ============================================================================
-- TEST 6 — Admin cancela reserva de SOCIO mock → devuelve al SOCIO
-- ============================================================================
SELECT pg_temp._reset();
-- David se vuelve admin temporalmente
UPDATE usuarios SET rol = 'admin' WHERE id = (SELECT socio_id FROM _tst_ctx);

-- Tier compartido (David + mock) → creditos
UPDATE tiers SET tipo = 'creditos', clases_incluidas = 10, duracion_dias = NULL
WHERE id = (SELECT tier_id FROM _tst_ctx);

-- Membresía del mock con saldo 5
UPDATE membresias SET creditos_restantes = 5, periodo_actual_fin = NULL
WHERE id = (SELECT mock_mem_id FROM _tst_ctx);

-- Reserva mock del SOCIO (INSERT directo) + movimiento débito (también directo)
WITH ins_reserva AS (
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
    'TST-T6-' || lpad((floor(random() * 99999))::int::text, 5, '0'),
    c.id, 'reserva mock test 6'
  FROM clases c WHERE c.id = (SELECT clase1_id FROM _tst_ctx)
  RETURNING id, tenant_id
)
INSERT INTO membresia_movimientos (
  membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
)
SELECT
  (SELECT mock_mem_id FROM _tst_ctx), ir.tenant_id, 'debito', -1, ir.id,
  'mock debito test 6', (SELECT mock_id FROM _tst_ctx)
FROM ins_reserva ir;

-- Bajar el saldo del mock a 4 (consistente con el débito)
UPDATE membresias SET creditos_restantes = 4
WHERE id = (SELECT mock_mem_id FROM _tst_ctx);

SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_reserva_id uuid;
  v_cancel jsonb;
  v_saldo_mock integer;
  v_devolucion record;
BEGIN
  SELECT id INTO v_reserva_id FROM reservas
  WHERE notas = 'reserva mock test 6'
  ORDER BY created_at DESC LIMIT 1;

  -- David (admin) cancela la reserva del mock
  v_cancel := cancelar_reserva_atomic(v_reserva_id, 'test 6 admin');

  SELECT creditos_restantes INTO v_saldo_mock FROM membresias
  WHERE id = (SELECT mock_mem_id FROM _tst_ctx);

  SELECT tipo, delta_creditos, created_by INTO v_devolucion
  FROM membresia_movimientos
  WHERE reserva_id = v_reserva_id AND tipo = 'devolucion';

  IF (v_cancel->>'success')::boolean
     AND (v_cancel->>'devuelto')::boolean
     AND (v_cancel->>'devolucion_motivo') = 'a_tiempo'
     AND v_saldo_mock = 5            -- el saldo del MOCK subió 4→5
     AND v_devolucion.tipo = 'devolucion'
     AND v_devolucion.delta_creditos = 1
     AND v_devolucion.created_by = (SELECT socio_id FROM _tst_ctx) THEN  -- David, no el mock
    INSERT INTO _tst_results VALUES (6, 'Admin cancela reserva de socio → devuelve al socio', TRUE,
      format('saldo mock 4→5, devolucion.created_by=david'));
  ELSE
    INSERT INTO _tst_results VALUES (6, 'Admin cancela reserva de socio → devuelve al socio', FALSE,
      format('devuelto=%s motivo=%s saldo_mock=%s mov.tipo=%s mov.delta=%s mov.by=%s',
        v_cancel->>'devuelto', v_cancel->>'devolucion_motivo', v_saldo_mock,
        v_devolucion.tipo, v_devolucion.delta_creditos, v_devolucion.created_by));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst_results VALUES (6, 'Admin cancela reserva de socio → devuelve al socio', FALSE,
    'error inesperado: ' || SQLERRM);
END $t$;

-- ============================================================================
-- TEST 7 — RESERVA_PASADA: la clase ya empezó → bloquea cancelación
-- ============================================================================
SELECT pg_temp._reset();

-- Insertar una reserva en una clase futura, PERO con slot_inicio en el pasado.
-- (Para que cancelar_reserva_atomic vea slot_inicio <= now y bloquee con
-- RESERVA_PASADA, sin tocar la clase real.)
INSERT INTO reservas (
  tenant_id, recurso_id, usuario_id,
  slot_inicio, slot_fin, duracion_min,
  invitados_count, status, folio, clase_id, notas
)
SELECT
  c.tenant_id, c.recurso_id, (SELECT socio_id FROM _tst_ctx),
  now() - interval '2 hours',
  now() - interval '1 hour',
  60, 0, 'confirmada',
  'TST-T7-' || lpad((floor(random() * 99999))::int::text, 5, '0'),
  c.id, 'reserva slot pasado test 7'
FROM clases c WHERE c.id = (SELECT clase1_id FROM _tst_ctx);

SELECT pg_temp._as((SELECT socio_auth_id FROM _tst_ctx));

DO $t$
DECLARE
  v_reserva_id uuid;
  v_err text;
  v_status text;
BEGIN
  SELECT id INTO v_reserva_id FROM reservas
  WHERE notas = 'reserva slot pasado test 7'
  ORDER BY created_at DESC LIMIT 1;

  BEGIN
    PERFORM cancelar_reserva_atomic(v_reserva_id, 'test 7');
    INSERT INTO _tst_results VALUES (7, 'RESERVA_PASADA bloquea cancelación', FALSE,
      'no falló (esperado RESERVA_PASADA)');
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  SELECT status INTO v_status FROM reservas WHERE id = v_reserva_id;

  IF v_err LIKE 'RESERVA_PASADA%' AND v_status = 'confirmada' THEN
    INSERT INTO _tst_results VALUES (7, 'RESERVA_PASADA bloquea cancelación', TRUE,
      'err=RESERVA_PASADA, status sigue en confirmada');
  ELSE
    INSERT INTO _tst_results VALUES (7, 'RESERVA_PASADA bloquea cancelación', FALSE,
      format('err=%s status=%s', v_err, v_status));
  END IF;
END $t$;

-- ============================================================================
-- Cierre — restaurar todo + descartar la sesión impersonada
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
