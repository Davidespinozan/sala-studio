-- ============================================================================
-- REACTIVAR CLASE — deshacer una cancelación puntual (sin RPC hasta hoy)
-- ----------------------------------------------------------------------------
-- Caso real: numa canceló 4 clases de "FUERZA + CardioHiit" del sábado
-- 2026-10-17 (06/07/08/09h) el 2026-09-03 vía cancelar_clase, y ahora pide
-- reabrirlas. No existía ningún camino para deshacerlo — ni RPC ni botón.
--
-- Simétrica a cancelar_clase: acepta (p_clase_id) o (p_horario_id, p_fecha)
-- virtual — materializa si hace falta (una clase virtual nunca está
-- 'cancelada', así que materializarla solo tiene sentido si YA existe la fila
-- cancelada; si no existe, no hay nada que reactivar).
--
-- Qué NO hace (a propósito): no restaura las reservas que se cancelaron al
-- momento de cancelar la clase (ya se les devolvió el crédito — reinventar esa
-- reserva sería cobrarles de nuevo sin que lo pidan). Reactivar solo vuelve a
-- abrir el cupo para que alguien reserve de nuevo. Si había inscritos y el
-- gym quiere avisarles, lo hace aparte (notificación/WhatsApp).
--
-- Guard: una clase 'completada' no se reactiva (ya pasó y se tomó asistencia).
-- Idempotente: reactivar algo que ya está 'programada' no hace nada.
-- Autorización: igual que cancelar_clase (recepción o admin).
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION reactivar_clase(
  p_clase_id uuid DEFAULT NULL,
  p_horario_id uuid DEFAULT NULL,
  p_fecha date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_clase_id uuid;
  v_clase clases;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden reactivar una clase';
  END IF;

  IF p_clase_id IS NOT NULL THEN
    v_clase_id := p_clase_id;
  ELSIF p_horario_id IS NOT NULL AND p_fecha IS NOT NULL THEN
    -- Solo tiene fila materializada si YA se había cancelado antes.
    SELECT id INTO v_clase_id FROM clases
    WHERE tenant_id = v_tenant AND horario_recurrente_id = p_horario_id AND fecha = p_fecha
    ORDER BY (status = 'cancelada') DESC, created_at DESC
    LIMIT 1;
    IF v_clase_id IS NULL THEN
      RAISE EXCEPTION 'CLASE_NO_EXISTE: esa clase nunca se canceló, no hay nada que reactivar';
    END IF;
  ELSE
    RAISE EXCEPTION 'PARAMS: se requiere p_clase_id o (p_horario_id, p_fecha)';
  END IF;

  SELECT * INTO v_clase FROM clases WHERE id = v_clase_id;
  IF v_clase.id IS NULL THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: no encontramos esa clase';
  END IF;
  IF v_clase.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: esa clase no pertenece a tu gimnasio';
  END IF;
  IF v_clase.status = 'completada' THEN
    RAISE EXCEPTION 'CLASE_COMPLETADA: ya pasó y se tomó asistencia, no se puede reactivar';
  END IF;
  IF v_clase.status = 'programada' THEN
    RETURN jsonb_build_object('reactivada', false, 'clase_id', v_clase_id, 'reason', 'ya_estaba_programada');
  END IF;

  UPDATE clases
  SET status = 'programada', cancelada_at = NULL, cancelada_motivo = NULL
  WHERE id = v_clase_id;

  RETURN jsonb_build_object('reactivada', true, 'clase_id', v_clase_id, 'fecha', v_clase.fecha, 'hora_inicio', v_clase.hora_inicio);
END;
$$;

REVOKE ALL ON FUNCTION reactivar_clase(uuid, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION reactivar_clase(uuid, uuid, date) FROM anon;
GRANT EXECUTE ON FUNCTION reactivar_clase(uuid, uuid, date) TO authenticated;

COMMENT ON FUNCTION reactivar_clase(uuid, uuid, date) IS
  'Deshace una cancelación puntual (cancelar_clase): vuelve el status a '
  'programada y abre el cupo de nuevo. NO restaura las reservas que ya se '
  'cancelaron ni les vuelve a cobrar el crédito devuelto — eso lo decide el '
  'gym aparte. No reactiva una clase completada. Recepción o admin.';

-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — tenant desechable; cerrar_tenant limpia.
-- ============================================================================
CREATE TEMP TABLE _reactivar_clase_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $$
DECLARE
  v_slug text := 'zz-reactivar-'||substr(md5(random()::text),1,6);
  v_tenant uuid; v_auth uuid := gen_random_uuid(); v_suc uuid; v_recurso uuid;
  v_horario uuid; v_clase_virtual uuid; v_clase_manual uuid; v_clase_completada uuid;
  v_r jsonb; v_ok boolean;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug, 'ReactivarClase', 'gym_libre', 'activo') RETURNING id INTO v_tenant;
  INSERT INTO auth.users (instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000',v_auth,'authenticated','authenticated',v_slug||'-admin@x.dev',
          '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('tenant_slug',v_slug,'nombre','Admin'),now(),now());
  UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth;
  INSERT INTO sucursales (tenant_id, nombre) VALUES (v_tenant, 'Principal') RETURNING id INTO v_suc;
  INSERT INTO recursos (tenant_id, sucursal_id, slug, nombre, tipo, cupo_max_default) VALUES (v_tenant, v_suc, 'sala-test', 'Sala', 'sala_grupal', 10) RETURNING id INTO v_recurso;
  INSERT INTO horarios_recurrentes (tenant_id, recurso_id, dias_semana, hora_inicio, nombre, cupo_max)
    VALUES (v_tenant, v_recurso, ARRAY[6], '08:00', 'Clase Test', 10) RETURNING id INTO v_horario;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- T1: clase VIRTUAL (nunca materializada) → no hay nada que reactivar
  v_ok := false;
  BEGIN PERFORM reactivar_clase(NULL, v_horario, CURRENT_DATE + 10);
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'CLASE_NO_EXISTE%'; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T1: debió fallar con CLASE_NO_EXISTE'; END IF;
  INSERT INTO _reactivar_clase_res VALUES (1, 'clase virtual nunca cancelada → CLASE_NO_EXISTE', 'OK');

  -- T2: cancelar + reactivar la MISMA clase virtual (flujo real de numa, por horario+fecha)
  PERFORM cancelar_clase(NULL, v_horario, CURRENT_DATE + 10, 'test');
  SELECT id INTO v_clase_virtual FROM clases WHERE horario_recurrente_id = v_horario AND fecha = CURRENT_DATE + 10;
  IF (SELECT status FROM clases WHERE id = v_clase_virtual) <> 'cancelada' THEN RAISE EXCEPTION 'T2 setup: no quedó cancelada'; END IF;
  v_r := reactivar_clase(NULL, v_horario, CURRENT_DATE + 10);
  IF NOT (v_r->>'reactivada')::boolean THEN RAISE EXCEPTION 'T2: no reactivó'; END IF;
  IF (SELECT status FROM clases WHERE id = v_clase_virtual) <> 'programada' THEN RAISE EXCEPTION 'T2: status no volvió a programada'; END IF;
  IF (SELECT cancelada_at FROM clases WHERE id = v_clase_virtual) IS NOT NULL THEN RAISE EXCEPTION 'T2: cancelada_at no se limpió'; END IF;
  INSERT INTO _reactivar_clase_res VALUES (2, 'cancelar + reactivar por (horario,fecha) → vuelve a programada, limpia cancelada_at', 'OK');

  -- T3: reactivar por clase_id directo, sobre una clase MANUAL cancelada
  INSERT INTO clases (tenant_id, sucursal_id, recurso_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, origen, status, cancelada_at, cancelada_motivo)
    VALUES (v_tenant, v_suc, v_recurso, CURRENT_DATE + 11, '10:00', 60, 'Manual', 10, 'manual', 'cancelada', now(), 'motivo x') RETURNING id INTO v_clase_manual;
  v_r := reactivar_clase(v_clase_manual, NULL, NULL);
  IF (SELECT status FROM clases WHERE id = v_clase_manual) <> 'programada' THEN RAISE EXCEPTION 'T3: no reactivó por clase_id'; END IF;
  IF (SELECT cancelada_motivo FROM clases WHERE id = v_clase_manual) IS NOT NULL THEN RAISE EXCEPTION 'T3: cancelada_motivo no se limpió'; END IF;
  INSERT INTO _reactivar_clase_res VALUES (3, 'reactivar por clase_id (manual) → limpia status + motivo', 'OK');

  -- T4: idempotente — reactivar algo YA programada no falla, avisa que no hizo nada
  v_r := reactivar_clase(v_clase_manual, NULL, NULL);
  IF (v_r->>'reactivada')::boolean THEN RAISE EXCEPTION 'T4: debió ser no-op'; END IF;
  INSERT INTO _reactivar_clase_res VALUES (4, 'reactivar algo ya programada → idempotente (no-op), no revienta', 'OK');

  -- T5: una clase COMPLETADA no se puede reactivar
  INSERT INTO clases (tenant_id, sucursal_id, recurso_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, origen, status)
    VALUES (v_tenant, v_suc, v_recurso, CURRENT_DATE - 1, '10:00', 60, 'Pasada', 10, 'manual', 'completada') RETURNING id INTO v_clase_completada;
  v_ok := false;
  BEGIN PERFORM reactivar_clase(v_clase_completada, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'CLASE_COMPLETADA%'; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T5: debió rechazar una clase completada'; END IF;
  INSERT INTO _reactivar_clase_res VALUES (5, 'clase completada → rechazada (CLASE_COMPLETADA)', 'OK');

  -- T6: sin sesión (anon) → sin EXECUTE
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false;
  BEGIN SET LOCAL ROLE anon;
    PERFORM reactivar_clase(v_clase_manual, NULL, NULL);
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  WHEN OTHERS THEN v_ok := SQLERRM LIKE 'NO_AUTORIZADO%'; END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'T6: anon no debió poder ejecutar reactivar_clase'; END IF;
  INSERT INTO _reactivar_clase_res VALUES (6, 'anon sin EXECUTE / NO_AUTORIZADO', 'OK');

  PERFORM cerrar_tenant(v_slug);
END $$;

SELECT orden, prueba, resultado FROM _reactivar_clase_res ORDER BY orden;

COMMIT;
