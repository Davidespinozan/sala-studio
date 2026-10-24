-- ============================================================================
-- TESTS — la clase se cuenta en el plan vigente (migración 20261023120000)
-- ============================================================================
-- USO: pegar entero en el SQL Editor (o psql). NO persiste nada: todo el
-- escenario corre dentro de un bloque que se revierte con un centinela; los
-- veredictos viven en variables plpgsql y se vuelcan a una tabla al final.
-- Sin session_replication_role (el SQL Editor no puede): el fixture se arma con
-- los RPCs reales (gestionar_membresia_socio, registrar_cargo_pendiente,
-- _aplicar_credito) como Alejandra, y las reservas se insertan con triggers
-- encendidos (sala.pase_dia=on salta la regla de día; horas dentro del horario).
-- Correr DESPUÉS de la migración y ANTES de scripts/fix_betsaida_traslado_paq12
-- (la prueba 1 usa el dato real de Betsaida tal como quedó el 23-oct).
--
-- COBERTURA:
--   1. Dato real de Betsaida: el helper traslada SAL-000272 al Paquete 12 (12 → 11)
--   2. Idempotente: segunda llamada → plan_origen_vigente, saldo sigue 11
--   3. Candado: asignar otro plan con un plan por cobrar pendiente → PLAN_POR_COBRAR_PENDIENTE
--   4. Cancelar el plan por cobrar libera la reserva FUTURA debitada y deja la en curso
--   5. Con el candado despejado, asignar Paquete 12 funciona (alta, 12 clases)
--   6. Marcar asistencia de la clase en curso → completada, trasladada, 12 → 11
--   7. Reserva de un plan PAGADO y cancelado → no se re-cobra (plan_origen_pagado)
--   8. Plan vigente sin saldo → SIN_CREDITOS_TRASLADO (no marca presente)
-- Fixture: socio sintético en The Core; recepción = Alejandra Rendón (admin real).
-- ============================================================================
DROP TABLE IF EXISTS _rspv_t;
CREATE TEMP TABLE _rspv_t (n int, prueba text, ok boolean, detalle text);

DO $t$
DECLARE
  v_tenant uuid := '8449c9c5-c551-4f59-9c49-994ec3a9d745';   -- The Core Studio
  v_suc    uuid := '9dc89129-2482-4b5c-a80c-2ccaa7b0c6ff';
  v_tier_prueba uuid := 'ad62fb76-30b4-400c-9052-a5aa8ec05ce4';
  v_tier_paq12  uuid := '8740e3f9-627a-424a-bc22-ca2b7713c03c';
  v_clase  uuid := 'eefa32af-4b03-4f6b-a59d-392801f6f2ba';   -- POLE FITNESS 23-oct 08:30
  v_recurso uuid := '928974e9-0ea3-49a9-bd49-7fea21b7cb2f';
  v_alejandra uuid := '1910dd97-9f4d-4245-ad3a-a3f5f1a3a647';
  v_alejandra_auth uuid;
  -- Betsaida
  v_bets_reserva uuid := 'f049837d-8020-42db-96a0-e42b5cf014b3';
  v_bets_paq12   uuid := 'a7cc6aeb-71b4-4111-9d45-2da508d056ad';
  -- mock
  v_mock uuid := gen_random_uuid();
  v_memA uuid;                        -- prueba por cobrar (la crea gestionar_membresia_socio)
  v_memC uuid := gen_random_uuid();   -- plan pagado y cancelado (prueba 7)
  v_memNueva uuid;
  v_r1 uuid := gen_random_uuid();     -- futura (próximo lunes 08:30 Mazatlán)
  v_r2 uuid := gen_random_uuid();     -- en curso (empezó hace 30 min)
  v_r3 uuid := gen_random_uuid();     -- de memC (ayer)
  v_r4 uuid := gen_random_uuid();     -- hace 2 días, para prueba 8
  v_lunes timestamptz := (date_trunc('day', now() AT TIME ZONE 'America/Mazatlan')
                          + ((8 - extract(isodow FROM now() AT TIME ZONE 'America/Mazatlan'))::int || ' days')::interval
                          + interval '8 hours 30 minutes') AT TIME ZONE 'America/Mazatlan';
  v_sfx text := substr(md5(random()::text), 1, 6);
  v_res jsonb; v_saldo integer; v_n integer; v_st text; v_mem uuid; v_err text;
  ok1 boolean; d1 text; ok2 boolean; d2 text; ok3 boolean; d3 text; ok4 boolean; d4 text;
  ok5 boolean; d5 text; ok6 boolean; d6 text; ok7 boolean; d7 text; ok8 boolean; d8 text;
BEGIN
  BEGIN
    SELECT auth_id INTO v_alejandra_auth FROM usuarios WHERE id = v_alejandra;
    IF v_alejandra_auth IS NULL THEN RAISE EXCEPTION 'SETUP: Alejandra sin auth_id'; END IF;

    -- ── 1. Betsaida real ───────────────────────────────────────────────────
    PERFORM 1 FROM reservas WHERE id = v_bets_reserva FOR UPDATE;
    v_res := _reserva_trasladar_a_plan_vigente(v_bets_reserva, NULL);
    SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_bets_paq12;
    SELECT membresia_id INTO v_mem FROM reservas WHERE id = v_bets_reserva;
    SELECT count(*) INTO v_n FROM membresia_movimientos
      WHERE reserva_id = v_bets_reserva AND membresia_id = v_bets_paq12 AND tipo = 'debito' AND delta_creditos = -1;
    ok1 := COALESCE((v_res->>'trasladada')::boolean, false) AND v_saldo = 11 AND v_mem = v_bets_paq12 AND v_n = 1;
    d1 := format('res=%s saldo=%s mem_ok=%s debitos=%s', v_res, v_saldo, v_mem = v_bets_paq12, v_n);

    -- ── 2. Idempotente ─────────────────────────────────────────────────────
    v_res := _reserva_trasladar_a_plan_vigente(v_bets_reserva, NULL);
    SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_bets_paq12;
    ok2 := (v_res->>'trasladada')::boolean IS FALSE AND v_res->>'reason' = 'plan_origen_vigente' AND v_saldo = 11;
    d2 := format('res=%s saldo=%s', v_res, v_saldo);

    -- ── fixture: socio mock con Clase prueba POR COBRAR y dos reservas ─────
    -- recepción = Alejandra (los RPCs del fixture exigen staff)
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_alejandra_auth::text)::text, true);

    INSERT INTO usuarios (id, tenant_id, nombre, email, rol, status, sucursal_id)
    VALUES (v_mock, v_tenant, 'ZZ Test traslado', 'zz-traslado-' || v_sfx || '@example.com',
            'miembro', 'activo', v_suc);

    -- Alta de la prueba "dejar pendiente" (mismo camino que el admin: gestionar + cargo).
    v_res := gestionar_membresia_socio(v_mock, v_tier_prueba, 'alta test (por cobrar)', NULL);
    v_memA := (v_res->>'membresia_id')::uuid;
    PERFORM registrar_cargo_pendiente(v_mock, 9900, 'plan', 'Clase prueba', NULL);

    -- Dos reservas de esa membresía, ambas con su débito (la prueba trae 1 crédito:
    -- se le suma 1 de ajuste para poder debitar las dos).
    PERFORM set_config('sala.pase_dia', 'on', true);  -- salta la regla de día del tier
    INSERT INTO reservas (id, tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status,
                          clase_id, invitados_count, entitlement_source, membresia_id)
    VALUES
      (v_r1, v_tenant, v_recurso, v_mock, v_lunes, v_lunes + interval '1 hour', 60, 'TST1-' || v_sfx, 'confirmada',
       v_clase, 0, 'membership', v_memA),
      (v_r2, v_tenant, v_recurso, v_mock, now() - interval '30 minutes', now() + interval '30 minutes', 60, 'TST2-' || v_sfx, 'confirmada',
       v_clase, 0, 'membership', v_memA);
    PERFORM set_config('sala.pase_dia', 'off', true);
    PERFORM _aplicar_credito(v_memA, 1, 'ajuste', 'test: crédito extra para la 2a reserva', NULL, NULL, v_alejandra);
    PERFORM _aplicar_credito(v_memA, -1, 'debito', 'reserva TST1 (test)', v_r1, NULL, v_alejandra);
    PERFORM _aplicar_credito(v_memA, -1, 'debito', 'reserva TST2 (test)', v_r2, NULL, v_alejandra);

    -- ── 3. Candado ─────────────────────────────────────────────────────────
    BEGIN
      PERFORM gestionar_membresia_socio(v_mock, v_tier_paq12, 'test', 'efectivo');
      ok3 := false; d3 := 'no lanzó';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      ok3 := position('PLAN_POR_COBRAR_PENDIENTE' IN v_err) > 0;
      d3 := v_err;
    END;

    -- ── 4. Cancelar el plan por cobrar ─────────────────────────────────────
    v_res := _cancelar_plan_por_cobrar(v_mock, 'test');
    SELECT status INTO v_st FROM reservas WHERE id = v_r1;
    SELECT status INTO d4 FROM reservas WHERE id = v_r2;
    ok4 := COALESCE((v_res->>'plan_cancelado')::boolean, false)
       AND (v_res->>'reservas_liberadas')::integer = 1
       AND (v_res->>'reservas_en_curso')::integer = 1
       AND v_st = 'cancelada_admin' AND d4 = 'confirmada';
    d4 := format('res=%s r1=%s r2=%s', v_res, v_st, d4);

    -- ── 5. Ahora sí: Paquete 12 ────────────────────────────────────────────
    v_res := gestionar_membresia_socio(v_mock, v_tier_paq12, 'test', 'efectivo');
    v_memNueva := (v_res->>'membresia_id')::uuid;
    SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_memNueva;
    ok5 := v_res->>'modo' = 'alta' AND v_saldo = 12 AND v_memNueva <> v_memA;
    d5 := format('modo=%s saldo=%s nueva=%s', v_res->>'modo', v_saldo, v_memNueva);

    -- ── 6. Marcar asistencia de la clase en curso ──────────────────────────
    v_res := admin_marcar_asistencia(v_r2, 'test');
    SELECT status, membresia_id INTO v_st, v_mem FROM reservas WHERE id = v_r2;
    SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_memNueva;
    ok6 := v_st = 'completada' AND v_mem = v_memNueva AND v_saldo = 11
       AND COALESCE((v_res->'traslado'->>'trasladada')::boolean, false)
       AND (v_res->'traslado'->>'creditos')::integer = 1;
    d6 := format('status=%s mem_ok=%s saldo=%s traslado=%s', v_st, v_mem = v_memNueva, v_saldo, v_res->'traslado');

    -- ── 7. Plan pagado y cancelado: NO se re-cobra ─────────────────────────
    PERFORM set_config('sala.pase_dia', 'on', true);
    INSERT INTO membresias (id, tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin,
                            creditos_restantes, sucursal_id, created_at, cancelada_at)
    VALUES (v_memC, v_tenant, v_mock, v_tier_paq12, 'cancelada', now() - interval '40 days', now() - interval '10 days',
            3, v_suc, now() - interval '40 days', now() - interval '10 days');
    INSERT INTO pagos (tenant_id, sucursal_id, usuario_id, membresia_id, tier_id, concepto, monto_centavos, moneda, metodo, notas, cobrado_por, created_at)
    VALUES (v_tenant, v_suc, v_mock, v_memC, v_tier_paq12, 'paquete', 165000, 'MXN', 'efectivo', 'test', v_alejandra, now() - interval '40 days');
    INSERT INTO reservas (id, tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status,
                          clase_id, invitados_count, entitlement_source, membresia_id)
    VALUES (v_r3, v_tenant, v_recurso, v_mock, now() - interval '1 day 30 minutes', now() - interval '1 day' + interval '30 minutes', 60, 'TST3-' || v_sfx, 'confirmada',
            v_clase, 0, 'membership', v_memC);
    PERFORM set_config('sala.pase_dia', 'off', true);
    v_res := _reserva_trasladar_a_plan_vigente(v_r3, NULL);
    SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_memNueva;
    ok7 := (v_res->>'trasladada')::boolean IS FALSE AND v_res->>'reason' = 'plan_origen_pagado' AND v_saldo = 11;
    d7 := format('res=%s saldo=%s', v_res, v_saldo);

    -- ── 8. Sin saldo en el plan vigente → SIN_CREDITOS_TRASLADO ────────────
    PERFORM set_config('sala.pase_dia', 'on', true);
    INSERT INTO reservas (id, tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status,
                          clase_id, invitados_count, entitlement_source, membresia_id)
    VALUES (v_r4, v_tenant, v_recurso, v_mock, now() - interval '2 days 30 minutes', now() - interval '2 days' + interval '30 minutes', 60, 'TST4-' || v_sfx, 'confirmada',
            v_clase, 0, 'membership', v_memA);
    PERFORM set_config('sala.pase_dia', 'off', true);
    PERFORM _aplicar_credito(v_memA, 1, 'ajuste', 'test: crédito para la reserva 4', NULL, NULL, v_alejandra);
    PERFORM _aplicar_credito(v_memA, -1, 'debito', 'reserva TST4 (test)', v_r4, NULL, v_alejandra);
    -- Drena el plan vigente (11 → 0) por la puerta canónica del saldo.
    PERFORM _aplicar_credito(v_memNueva, -11, 'ajuste', 'test: drena saldo para probar SIN_CREDITOS_TRASLADO', NULL, NULL, v_alejandra);
    BEGIN
      PERFORM admin_marcar_asistencia(v_r4, 'test');
      ok8 := false; d8 := 'no lanzó';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      SELECT status INTO v_st FROM reservas WHERE id = v_r4;
      ok8 := position('SIN_CREDITOS_TRASLADO' IN v_err) > 0;
      d8 := v_err;
    END;

    RAISE EXCEPTION 'ROLLBACK_SENTINEL';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_SENTINEL' THEN
      INSERT INTO _rspv_t VALUES (0, 'EL ESCENARIO TRONÓ (todo revertido)', false, SQLERRM);
    END IF;
  END;

  INSERT INTO _rspv_t VALUES
    (1, 'Betsaida real: SAL-000272 pasa al Paquete 12 y debita 1 (12 → 11)', COALESCE(ok1, false), d1),
    (2, 'Idempotente: segunda llamada no vuelve a debitar', COALESCE(ok2, false), d2),
    (3, 'Candado: asignar plan con uno por cobrar pendiente → PLAN_POR_COBRAR_PENDIENTE', COALESCE(ok3, false), d3),
    (4, 'Cancelar por cobrar: libera la futura debitada, deja la en curso, reporta conteos', COALESCE(ok4, false), d4),
    (5, 'Con el candado despejado, asignar Paquete 12 = alta con 12 clases', COALESCE(ok5, false), d5),
    (6, 'Marcar asistencia de la clase en curso → trasladada al Paquete 12 (12 → 11)', COALESCE(ok6, false), d6),
    (7, 'Plan pagado y cancelado: NO se re-cobra (plan_origen_pagado)', COALESCE(ok7, false), d7),
    (8, 'Plan vigente sin saldo → SIN_CREDITOS_TRASLADO y no marca presente', COALESCE(ok8, false), d8);
END $t$;

SELECT n, prueba, CASE WHEN ok THEN '✅' ELSE '❌' END AS ok, detalle
FROM _rspv_t ORDER BY n;
