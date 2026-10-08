-- ============================================================================
-- TESTS — eliminar_horario_recurrente (self-tests que DEVUELVEN UNA TABLA)
-- ----------------------------------------------------------------------------
-- Correr DESPUÉS de 20261008230000_eliminar_horario_sin_huerfanas.sql.
-- Cada bloque arma su escenario sobre healthyspace (demo) en una
-- subtransacción y la revierte con un centinela (RAISE 'RB_*'). NO persiste
-- nada. Resultados: OK / SKIP (...) / FAIL: ... / ERROR: ...
--
-- Cubre: 1) borra futuras sin nada colgado; conserva futura con reserva,
--           pasada, y la de otro horario; borra el horario
--        2) un no-admin no puede
--        3) un admin no puede borrar el horario de OTRO gym
-- ============================================================================

DROP TABLE IF EXISTS _eh_test_results;
CREATE TEMP TABLE _eh_test_results (orden int, test text, resultado text);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Borrado selectivo
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_res text := 'SKIP (sin healthyspace/admin/sala)';
  v_tenant uuid; v_admin RECORD; v_rec RECORD;
  v_h uuid; v_h_otro uuid;
  c_libre uuid; c_reserva uuid; c_pasada uuid; c_otro uuid;
  v_out jsonb;
  v_hoy date := (now() AT TIME ZONE 'America/Mexico_City')::date;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'healthyspace';
  SELECT id, auth_id INTO v_admin FROM usuarios
    WHERE tenant_id = v_tenant AND rol = 'admin' AND status = 'activo' AND auth_id IS NOT NULL LIMIT 1;
  SELECT id, sucursal_id INTO v_rec FROM recursos WHERE tenant_id = v_tenant AND activo LIMIT 1;

  IF v_tenant IS NOT NULL AND v_admin.id IS NOT NULL AND v_rec.id IS NOT NULL THEN
    BEGIN
      -- activo=false: el guard de solape no aplica y expandir_clases no lo usa.
      INSERT INTO horarios_recurrentes (tenant_id, recurso_id, sucursal_id, dias_semana, hora_inicio, duracion_minutos, nombre, activo)
      VALUES (v_tenant, v_rec.id, v_rec.sucursal_id, ARRAY[0,1,2,3,4,5,6], '03:11', 15, 'TEST eliminar', false)
      RETURNING id INTO v_h;
      INSERT INTO horarios_recurrentes (tenant_id, recurso_id, sucursal_id, dias_semana, hora_inicio, duracion_minutos, nombre, activo)
      VALUES (v_tenant, v_rec.id, v_rec.sucursal_id, ARRAY[0,1,2,3,4,5,6], '03:41', 15, 'TEST otro', false)
      RETURNING id INTO v_h_otro;

      INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, origen, status, horario_recurrente_id)
      VALUES (v_tenant, v_rec.id, v_rec.sucursal_id, v_hoy + 3, '03:11', 15, 'TEST libre', 5, 'recurrente_modificada', 'programada', v_h)
      RETURNING id INTO c_libre;
      INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, origen, status, horario_recurrente_id)
      VALUES (v_tenant, v_rec.id, v_rec.sucursal_id, v_hoy + 4, '03:11', 15, 'TEST con reserva', 5, 'recurrente_modificada', 'programada', v_h)
      RETURNING id INTO c_reserva;
      INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, origen, status, horario_recurrente_id)
      VALUES (v_tenant, v_rec.id, v_rec.sucursal_id, v_hoy - 5, '03:11', 15, 'TEST pasada', 5, 'recurrente_modificada', 'programada', v_h)
      RETURNING id INTO c_pasada;
      INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, origen, status, horario_recurrente_id)
      VALUES (v_tenant, v_rec.id, v_rec.sucursal_id, v_hoy + 3, '03:41', 15, 'TEST otro horario', 5, 'recurrente_modificada', 'programada', v_h_otro)
      RETURNING id INTO c_otro;

      -- Una reserva CANCELADA basta para que la clase se conserve (cualquier status).
      -- staff_benefit: el usuario es admin y no exige membresia_id (CHECK de procedencia).
      INSERT INTO reservas (tenant_id, recurso_id, usuario_id, clase_id, slot_inicio, slot_fin, duracion_min, folio, status, entitlement_source)
      VALUES (v_tenant, v_rec.id, v_admin.id, c_reserva,
              (v_hoy + 4) + time '03:11', (v_hoy + 4) + time '03:26', 15,
              'TEST-' || substr(gen_random_uuid()::text, 1, 8), 'cancelada', 'staff_benefit');

      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin.auth_id::text)::text, true);
      PERFORM set_config('request.headers', json_build_object('x-tenant-id', v_tenant::text)::text, true);
      v_out := eliminar_horario_recurrente(v_h);

      IF EXISTS (SELECT 1 FROM clases WHERE id = c_libre) THEN
        v_res := 'FAIL: la clase futura libre NO se borró';
      ELSIF NOT EXISTS (SELECT 1 FROM clases WHERE id = c_reserva) THEN
        v_res := 'FAIL: se borró la clase CON reserva';
      ELSIF NOT EXISTS (SELECT 1 FROM reservas WHERE clase_id = c_reserva) THEN
        v_res := 'FAIL: se perdió la reserva';
      ELSIF NOT EXISTS (SELECT 1 FROM clases WHERE id = c_pasada) THEN
        v_res := 'FAIL: se borró la clase pasada';
      ELSIF NOT EXISTS (SELECT 1 FROM clases WHERE id = c_otro AND horario_recurrente_id = v_h_otro) THEN
        v_res := 'FAIL: tocó la clase de otro horario';
      ELSIF EXISTS (SELECT 1 FROM horarios_recurrentes WHERE id = v_h) THEN
        v_res := 'FAIL: el horario no se borró';
      ELSIF (v_out->>'clases_borradas')::int <> 1 OR (v_out->>'clases_conservadas')::int <> 1 THEN
        v_res := 'FAIL: conteos ' || v_out::text;
      ELSE
        v_res := 'OK';
      END IF;
      RAISE EXCEPTION 'RB_1';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'RB_1' THEN v_res := 'ERROR: ' || SQLERRM; END IF;
    END;
  END IF;
  INSERT INTO _eh_test_results VALUES (1, 'borrado-selectivo', v_res);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) No-admin
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_res text := 'SKIP (sin healthyspace/miembro/horario)';
  v_tenant uuid; v_auth uuid; v_h uuid;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'healthyspace';
  SELECT auth_id INTO v_auth FROM usuarios
    WHERE tenant_id = v_tenant AND rol = 'miembro' AND status = 'activo' AND auth_id IS NOT NULL LIMIT 1;
  SELECT id INTO v_h FROM horarios_recurrentes WHERE tenant_id = v_tenant LIMIT 1;
  IF v_auth IS NOT NULL AND v_h IS NOT NULL THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);
      PERFORM set_config('request.headers', json_build_object('x-tenant-id', v_tenant::text)::text, true);
      PERFORM eliminar_horario_recurrente(v_h);
      v_res := 'FAIL: un miembro pudo eliminar';
      RAISE EXCEPTION 'RB_2';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'NO_AUTORIZADO%' THEN v_res := 'OK';
      ELSIF SQLERRM <> 'RB_2' THEN v_res := 'ERROR: ' || SQLERRM; END IF;
    END;
  END IF;
  INSERT INTO _eh_test_results VALUES (2, 'no-admin-rechazado', v_res);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Cross-tenant
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_res text := 'SKIP (sin admin demo / horario ajeno)';
  v_tenant uuid; v_auth uuid; v_h_ajeno uuid;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'healthyspace';
  SELECT auth_id INTO v_auth FROM usuarios
    WHERE tenant_id = v_tenant AND rol = 'admin' AND status = 'activo' AND auth_id IS NOT NULL LIMIT 1;
  SELECT id INTO v_h_ajeno FROM horarios_recurrentes WHERE tenant_id <> v_tenant LIMIT 1;
  IF v_auth IS NOT NULL AND v_h_ajeno IS NOT NULL THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);
      PERFORM set_config('request.headers', json_build_object('x-tenant-id', v_tenant::text)::text, true);
      PERFORM eliminar_horario_recurrente(v_h_ajeno);
      v_res := 'FAIL: borró el horario de otro gym';
      RAISE EXCEPTION 'RB_3';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'HORARIO_NO_ENCONTRADO%' THEN v_res := 'OK';
      ELSIF SQLERRM <> 'RB_3' THEN v_res := 'ERROR: ' || SQLERRM; END IF;
    END;
  END IF;
  INSERT INTO _eh_test_results VALUES (3, 'cross-tenant-rechazado', v_res);
END $$;

SELECT test, resultado FROM _eh_test_results ORDER BY orden;
