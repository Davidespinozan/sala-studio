-- ============================================================================
-- TESTS — re-reservar la misma clase tras cancelación tardía traslada el crédito
-- (migración 20261007190000). Correr DESPUÉS de la migración.
-- ============================================================================
-- USO: pegar entero en el SQL Editor. BEGIN/ROLLBACK → NO persiste nada.
--      Veredicto como TABLA al final.
--
-- Fixture: reservas sintéticas copiadas de una reserva real de Angie Meza (The
-- Core) en la misma clase. Las reservas se insertan con session_replication_role
-- = replica (para saltar los triggers de reglas de reserva, que no son lo que se
-- prueba); los débitos que SÍ se prueban se insertan con el rol normal para que
-- dispare el trigger nuevo.
--
-- COBERTURA:
--   1. Cancelación tardía (neto -1) + re-reserva misma clase → devolución +1 en
--      la vieja, saldo neto -1 (no -2)
--   2. Segunda re-reserva de la misma clase → ya no traslada (vieja quedó neto 0)
--   3. Cancelación tardía en OTRA clase → no traslada
--   4. Cancelación tardía en la misma clase pero con OTRA membresía → no traslada
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _r (n int PRIMARY KEY, test text, ok boolean, detalle text);

DO $t$
DECLARE
  v_base reservas;
  v_mem uuid := '4c26397a-8913-4f88-ac4c-a6908cae0e2f';
  v_tenant uuid;
  v_otra_clase uuid;
  v_saldo0 integer;
  v_saldo integer;
  v_vieja uuid := gen_random_uuid();
  v_nueva uuid := gen_random_uuid();
  v_nueva2 uuid := gen_random_uuid();
  v_vieja_otra uuid := gen_random_uuid();
  v_nueva_otra uuid := gen_random_uuid();
  v_vieja_mem2 uuid := gen_random_uuid();
  v_nueva_mem2 uuid := gen_random_uuid();
  v_mem2 uuid;
  v_n integer;
BEGIN
  SELECT * INTO v_base FROM reservas WHERE folio = 'SAL-000113'
    AND tenant_id = '8449c9c5-c551-4f59-9c49-994ec3a9d745';
  v_tenant := v_base.tenant_id;
  SELECT clase_id INTO v_otra_clase FROM reservas WHERE folio = 'SAL-000065' AND tenant_id = v_tenant;

  -- Reservas sintéticas (triggers de reglas apagados).
  SET LOCAL session_replication_role = replica;
  INSERT INTO reservas (id, tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min,
                        folio, status, cancelada_at, clase_id, invitados_count,
                        entitlement_source, membresia_id)
  SELECT x.id, v_tenant, v_base.recurso_id, v_base.usuario_id, v_base.slot_inicio, v_base.slot_fin, 60,
         x.folio, x.status, x.canc, x.clase, 0,
         'membership', v_mem
  FROM (VALUES
    (v_vieja,      'TST-001', 'cancelada',  now() - interval '1 hour', v_base.clase_id),
    (v_nueva,      'TST-002', 'confirmada', NULL::timestamptz,         v_base.clase_id),
    (v_nueva2,     'TST-003', 'confirmada', NULL,                      v_base.clase_id),
    (v_vieja_otra, 'TST-004', 'cancelada',  now() - interval '1 hour', v_otra_clase),
    (v_nueva_otra, 'TST-005', 'confirmada', NULL,                      v_base.clase_id),
    (v_vieja_mem2, 'TST-006', 'cancelada',  now() - interval '1 hour', v_base.clase_id),
    (v_nueva_mem2, 'TST-007', 'confirmada', NULL,                      v_base.clase_id)
  ) AS x(id, folio, status, canc, clase);
  SET LOCAL session_replication_role = origin;

  SELECT creditos_restantes INTO v_saldo0 FROM membresias WHERE id = v_mem FOR UPDATE;

  -- Débito retenido de la vieja (cancelación tardía: sin devolución).
  INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo)
  VALUES (v_mem, v_tenant, 'debito', -1, v_vieja, 'tst');
  UPDATE membresias SET creditos_restantes = creditos_restantes - 1 WHERE id = v_mem;

  -- ── 1: re-reserva misma clase
  UPDATE membresias SET creditos_restantes = creditos_restantes - 1 WHERE id = v_mem;
  INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo)
  VALUES (v_mem, v_tenant, 'debito', -1, v_nueva, 'tst');
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT COUNT(*) INTO v_n FROM membresia_movimientos WHERE reserva_id = v_vieja AND tipo = 'devolucion' AND delta_creditos = 1;
  INSERT INTO _r VALUES (1, 'tardía + re-reserva misma clase → traslada',
    v_saldo = v_saldo0 - 1 AND v_n = 1, format('saldo0=%s saldo=%s devol=%s', v_saldo0, v_saldo, v_n));

  -- ── 2: segunda re-reserva → no traslada otra vez
  UPDATE membresias SET creditos_restantes = creditos_restantes - 1 WHERE id = v_mem;
  INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo)
  VALUES (v_mem, v_tenant, 'debito', -1, v_nueva2, 'tst');
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT COUNT(*) INTO v_n FROM membresia_movimientos WHERE reserva_id = v_vieja AND tipo = 'devolucion';
  INSERT INTO _r VALUES (2, '2da re-reserva → no doble traslado',
    v_saldo = v_saldo0 - 2 AND v_n = 1, format('saldo=%s devol=%s', v_saldo, v_n));

  -- ── 3: tardía en OTRA clase → no traslada
  INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo)
  VALUES (v_mem, v_tenant, 'debito', -1, v_vieja_otra, 'tst');
  UPDATE membresias SET creditos_restantes = creditos_restantes - 2 WHERE id = v_mem; -- débito vieja_otra + nueva_otra
  INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo)
  VALUES (v_mem, v_tenant, 'debito', -1, v_nueva_otra, 'tst');
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT COUNT(*) INTO v_n FROM membresia_movimientos WHERE reserva_id = v_vieja_otra AND tipo = 'devolucion';
  INSERT INTO _r VALUES (3, 'tardía en otra clase → no traslada',
    v_saldo = v_saldo0 - 4 AND v_n = 0, format('saldo=%s devol=%s', v_saldo, v_n));

  -- ── 4: tardía misma clase pero débito en OTRA membresía → no traslada
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, sucursal_id, creditos_restantes,
                          periodo_actual_inicio, periodo_actual_fin)
  SELECT tenant_id, usuario_id, tier_id, 'expirada', sucursal_id, 0, now() - interval '60 days', now() - interval '30 days'
  FROM membresias WHERE id = v_mem
  RETURNING id INTO v_mem2;
  INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo)
  VALUES (v_mem2, v_tenant, 'debito', -1, v_vieja_mem2, 'tst');
  UPDATE membresias SET creditos_restantes = creditos_restantes - 1 WHERE id = v_mem;
  INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo)
  VALUES (v_mem, v_tenant, 'debito', -1, v_nueva_mem2, 'tst');
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_mem;
  SELECT COUNT(*) INTO v_n FROM membresia_movimientos WHERE reserva_id = v_vieja_mem2 AND tipo = 'devolucion';
  INSERT INTO _r VALUES (4, 'otra membresía → no traslada',
    v_saldo = v_saldo0 - 5 AND v_n = 0, format('saldo=%s devol=%s', v_saldo, v_n));
END
$t$;

SELECT n, test, CASE WHEN ok THEN '✅' ELSE '❌' END AS ok, detalle FROM _r ORDER BY n;

ROLLBACK;
