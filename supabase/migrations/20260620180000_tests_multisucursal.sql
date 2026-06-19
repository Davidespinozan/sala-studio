-- ============================================================================
-- TESTS — multi-sucursal (self-tests que DEVUELVEN UNA TABLA de resultados)
-- ----------------------------------------------------------------------------
-- Corré este archivo en el SQL Editor: al final hace SELECT y verás una tabla
--   test                     | resultado
--   default-sede             | OK
--   ...
-- Cada bloque arma su escenario en una subtransacción y la revierte con un
-- centinela (RAISE 'RB_*'). NO persiste nada (ni datos de prueba). El veredicto
-- viaja en variables plpgsql (que sobreviven al rollback del savepoint) y recién
-- después se inserta en una TEMP TABLE, que el SELECT final muestra.
--   OK            → el guard/trigger se comportó como se espera.
--   SKIP (...)    → faltan datos para montar el escenario (no es fallo).
--   FAIL: ...     → el comportamiento NO fue el esperado (hay que mirar).
--   ERROR: ...    → algo inesperado al montar el test.
--
-- Cubre: 1) trigger sede-por-defecto  2) herencia + rebind de membresia.sucursal_id
--        3) reservar_clase_atomic guard de sede  4) anotar_lista_espera guard de sede
-- ============================================================================

DROP TABLE IF EXISTS _ms_test_results;
CREATE TEMP TABLE _ms_test_results (orden int, test text, resultado text);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) usuario_default_sucursal
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_res text := 'SKIP (sin healthyspace/sucursales)';
  v_tenant uuid; v_def uuid; v_got uuid;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'healthyspace';
  IF v_tenant IS NOT NULL THEN
    SELECT id INTO v_def FROM sucursales WHERE tenant_id = v_tenant AND activa = true
      ORDER BY orden ASC, created_at ASC LIMIT 1;
    IF v_def IS NOT NULL THEN
      BEGIN
        INSERT INTO usuarios (tenant_id, email, rol, status, sucursal_id)
        VALUES (v_tenant, 'test-default-' || gen_random_uuid() || '@test.local', 'miembro', 'activo', NULL)
        RETURNING sucursal_id INTO v_got;

        IF v_got IS NULL THEN
          v_res := 'FAIL: socio nuevo quedó con sucursal_id NULL';
        ELSIF v_got <> v_def THEN
          v_res := 'FAIL: heredó ' || v_got || ' (esperaba ' || v_def || ')';
        ELSE
          v_res := 'OK';
        END IF;
        RAISE EXCEPTION 'RB_DEF';
      EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'RB_DEF' THEN v_res := 'ERROR: ' || left(SQLERRM, 80); END IF;
      END;
    END IF;
  END IF;
  INSERT INTO _ms_test_results VALUES (1, 'default-sede (socio nuevo hereda sede)', v_res);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Herencia (Fase 7) + rebind
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_her text := 'SKIP (faltan 2 sucursales / tier)';
  v_reb text := 'SKIP (faltan 2 sucursales / tier)';
  v_tenant uuid; v_a uuid; v_b uuid; v_tier uuid; v_uid uuid; v_mid uuid; v_got uuid;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'healthyspace';
  SELECT id INTO v_a FROM sucursales WHERE tenant_id = v_tenant AND activa = true
    ORDER BY orden ASC, created_at ASC LIMIT 1;
  SELECT id INTO v_b FROM sucursales WHERE tenant_id = v_tenant AND activa = true AND id <> v_a
    ORDER BY orden ASC, created_at ASC LIMIT 1;
  SELECT id INTO v_tier FROM tiers WHERE tenant_id = v_tenant AND activo = true LIMIT 1;

  IF v_tenant IS NOT NULL AND v_a IS NOT NULL AND v_b IS NOT NULL AND v_tier IS NOT NULL THEN
    BEGIN
      INSERT INTO usuarios (tenant_id, email, rol, status, sucursal_id)
      VALUES (v_tenant, 'test-rebind-' || gen_random_uuid() || '@test.local', 'miembro', 'activo', v_a)
      RETURNING id INTO v_uid;

      INSERT INTO membresias (tenant_id, usuario_id, tier_id, status)
      VALUES (v_tenant, v_uid, v_tier, 'activa')
      RETURNING id INTO v_mid;

      SELECT sucursal_id INTO v_got FROM membresias WHERE id = v_mid;
      v_her := CASE WHEN v_got IS NOT DISTINCT FROM v_a THEN 'OK'
                    ELSE 'FAIL: membresia.sucursal_id=' || COALESCE(v_got::text, 'NULL') || ' (esperaba ' || v_a || ')' END;

      UPDATE usuarios SET sucursal_id = v_b WHERE id = v_uid;
      SELECT sucursal_id INTO v_got FROM membresias WHERE id = v_mid;
      v_reb := CASE WHEN v_got IS NOT DISTINCT FROM v_b THEN 'OK'
                    ELSE 'FAIL: tras mudanza membresia.sucursal_id=' || COALESCE(v_got::text, 'NULL') || ' (esperaba ' || v_b || ')' END;

      RAISE EXCEPTION 'RB_REBIND';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'RB_REBIND' THEN
        v_her := 'ERROR: ' || left(SQLERRM, 80); v_reb := v_her;
      END IF;
    END;
  END IF;
  INSERT INTO _ms_test_results VALUES
    (2, 'herencia (membresía hereda sede del socio)', v_her),
    (3, 'rebind (mudar sede re-vincula la membresía)', v_reb);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 + 4) Guard de sede en reservar_clase_atomic y anotar_lista_espera.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_skip text := 'SKIP (sin escenario: tier 1-sede / sala / 2da sede / socio con membresía)';
  v_r_reservar text; v_r_lista text; v_r_pos text;
  v_tenant uuid; v_basica uuid; v_rec_b uuid; v_b uuid; v_a uuid;
  v_uid uuid; v_auth uuid; v_mid uuid; v_clase uuid;
BEGIN
  v_r_reservar := v_skip; v_r_lista := v_skip; v_r_pos := v_skip;

  SELECT id INTO v_tenant FROM tenants WHERE slug = 'healthyspace';
  SELECT id INTO v_basica FROM tiers
    WHERE tenant_id = v_tenant AND slug = 'basica' AND acceso_todas_sucursales = false LIMIT 1;
  SELECT r.id, r.sucursal_id INTO v_rec_b, v_b FROM recursos r
    WHERE r.tenant_id = v_tenant AND r.activo = true AND r.layout IS NULL
      AND r.sucursal_id IS NOT NULL AND 'basica' = ANY(r.tiers_permitidos)
    LIMIT 1;
  SELECT id INTO v_a FROM sucursales
    WHERE tenant_id = v_tenant AND activa = true AND id <> v_b
    ORDER BY orden ASC, created_at ASC LIMIT 1;
  SELECT u.id, u.auth_id, m.id INTO v_uid, v_auth, v_mid
  FROM usuarios u
  JOIN membresias m ON m.usuario_id = u.id AND m.status IN ('trialing','activa','past_due','congelada')
  WHERE u.tenant_id = v_tenant AND u.rol = 'miembro' AND u.auth_id IS NOT NULL
  LIMIT 1;

  IF v_tenant IS NOT NULL AND v_basica IS NOT NULL AND v_rec_b IS NOT NULL
     AND v_b IS NOT NULL AND v_a IS NOT NULL AND v_uid IS NOT NULL THEN
    BEGIN
      -- Escenario: socio en sede A, plan basica (1 sede) bound a A. Clase en sede B.
      UPDATE usuarios SET membresia_tier = 'basica', sucursal_id = v_a, status = 'activo', bloqueado_hasta = NULL
        WHERE id = v_uid;
      UPDATE membresias SET tier_id = v_basica, status = 'activa', sucursal_id = v_a,
             periodo_actual_fin = now() + interval '365 days'
        WHERE id = v_mid;
      INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status, origen)
      VALUES (v_tenant, v_rec_b, v_b, current_date + 30, time '10:00', 60, 'TEST clase sede B', 20, 'programada', 'manual')
      RETURNING id INTO v_clase;

      -- (3) reservar en sede ajena → debe lanzar SUCURSAL_NO_INCLUIDA
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);
      BEGIN
        PERFORM reservar_clase_atomic(v_clase, 0, NULL, NULL);
        v_r_reservar := 'FAIL: NO rechazó la sede ajena';
      EXCEPTION WHEN raise_exception THEN
        v_r_reservar := CASE WHEN SQLERRM LIKE '%SUCURSAL_NO_INCLUIDA%' THEN 'OK'
                             ELSE 'FAIL: lanzó "' || left(SQLERRM, 45) || '" (esperaba SUCURSAL_NO_INCLUIDA)' END;
      END;

      -- (4) lista de espera en sede ajena → debe lanzar SUCURSAL_NO_INCLUIDA
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);
      BEGIN
        PERFORM anotar_lista_espera(v_clase);
        v_r_lista := 'FAIL: NO rechazó la sede ajena';
      EXCEPTION WHEN raise_exception THEN
        v_r_lista := CASE WHEN SQLERRM LIKE '%SUCURSAL_NO_INCLUIDA%' THEN 'OK'
                          ELSE 'FAIL: lanzó "' || left(SQLERRM, 45) || '" (esperaba SUCURSAL_NO_INCLUIDA)' END;
      END;

      -- (positivo) membresía ahora es de la sede B → NO debe bloquear por sede.
      UPDATE membresias SET sucursal_id = v_b WHERE id = v_mid;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);
      BEGIN
        PERFORM reservar_clase_atomic(v_clase, 0, NULL, NULL);
        v_r_pos := 'OK (no bloqueó; reserva creada)';
      EXCEPTION WHEN raise_exception THEN
        v_r_pos := CASE WHEN SQLERRM LIKE '%SUCURSAL_NO_INCLUIDA%'
                        THEN 'FAIL: bloqueó por sede una clase de su propia sede'
                        ELSE 'OK (pasó el guard de sede; otra regla: ' || left(SQLERRM, 30) || ')' END;
      END;

      RAISE EXCEPTION 'RB_BOOK';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'RB_BOOK' THEN
        v_r_reservar := 'ERROR: ' || left(SQLERRM, 80); v_r_lista := v_r_reservar; v_r_pos := v_r_reservar;
      END IF;
    END;
  END IF;

  INSERT INTO _ms_test_results VALUES
    (4, 'reservar: rechaza sede fuera del plan', v_r_reservar),
    (5, 'lista_espera: rechaza sede fuera del plan', v_r_lista),
    (6, 'reservar: permite la sede propia', v_r_pos);
END $$;

-- Resultado visible (filas que el SQL Editor SÍ muestra).
SELECT orden AS "#", test, resultado FROM _ms_test_results ORDER BY orden;
