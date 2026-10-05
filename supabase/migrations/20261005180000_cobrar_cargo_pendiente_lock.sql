-- POST-W6 · cobrar_cargo_pendiente P1 — cierre del TOCTOU confirmado bajo concurrencia real.
--
-- Root cause: la lectura inicial de cargos_pendientes no tomaba lock, y el UPDATE final
-- era incondicional (sin WHERE estado='pendiente'). Bajo READ COMMITTED, dos cobradores
-- concurrentes (operation_key distintas — dos sesiones de staff) podían leer
-- estado='pendiente' antes de que cualquiera comiteara, generando DOS `pagos` reales
-- para el mismo cargo. Reproducido empíricamente con el código real (instrumentación
-- auxiliar con pg_sleep solo para ensanchar la ventana ya existente, sin cambiar lógica)
-- usando conexiones Postgres genuinamente concurrentes en un sandbox aislado.
--
-- Fix: agregar FOR UPDATE a la lectura inicial. Bajo READ COMMITTED, un segundo
-- cobrador se bloquea en ese SELECT hasta que el primero comitea; al despertar,
-- FOR UPDATE re-lee automáticamente la versión más reciente (no la snapshot original),
-- así que cae en el guard CARGO_NO_PENDIENTE ya existente ANTES de llegar al INSERT
-- de pagos. Cero restructuración: firma, operation_key/_op_begin/_op_finish, contrato
-- de respuesta, mensajes y permisos quedan idénticos. Único cambio: una palabra.
--
-- Evidencia de cierre: validación adversarial con conexiones Postgres reales (T1-T5),
-- documentada por separado — NO este self-test, que es determinista/secuencial y sirve
-- solo de regresión funcional básica.

CREATE OR REPLACE FUNCTION cobrar_cargo_pendiente(
  p_cargo_id uuid,
  p_metodo text DEFAULT 'efectivo',
  p_operation_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cargo cargos_pendientes;
  v_pago_id uuid;
  v_tenant uuid := get_my_tenant_id();
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden cobrar';
  END IF;
  IF p_metodo NOT IN ('efectivo','tarjeta','transferencia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: Método de pago no válido';
  END IF;

  -- Idempotencia ANTES del guard de estado: un reintento con la misma key devuelve
  -- el pago original (already_processed) en vez del confuso CARGO_NO_PENDIENTE.
  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'cobro_cargo', get_my_user_id(),
      md5(jsonb_build_object('cargo', p_cargo_id, 'metodo', p_metodo)::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  -- P1 fix: FOR UPDATE serializa a nivel de fila sobre ESTE cargo_id. Un segundo
  -- cobrador concurrente espera aquí, y al despertar ve el estado ya comiteado.
  SELECT * INTO v_cargo FROM cargos_pendientes WHERE id = p_cargo_id FOR UPDATE;
  IF v_cargo.id IS NULL OR v_cargo.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'CARGO_NO_EXISTE: Ese cargo no es de este gimnasio';
  END IF;
  IF v_cargo.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'CARGO_NO_PENDIENTE: Ese cargo ya está % (no se puede cobrar de nuevo)', v_cargo.estado;
  END IF;

  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id, concepto, monto_centavos, moneda, metodo, referencia, notas, cobrado_por
  ) VALUES (
    v_cargo.tenant_id, v_cargo.sucursal_id, v_cargo.usuario_id, v_cargo.concepto,
    v_cargo.monto_centavos, v_cargo.moneda, p_metodo, NULL,
    'Cobro de pendiente' || COALESCE(' · ' || v_cargo.descripcion, ''), get_my_user_id()
  )
  RETURNING id INTO v_pago_id;

  UPDATE cargos_pendientes
  SET estado = 'cobrado', pago_id = v_pago_id, cobrado_at = now()
  WHERE id = p_cargo_id;

  v_result := jsonb_build_object('success', true, 'pago_id', v_pago_id, 'monto_centavos', v_cargo.monto_centavos);
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION cobrar_cargo_pendiente(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cobrar_cargo_pendiente(uuid, text, uuid) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- Self-test determinista (regresión funcional básica, mismo estilo que wave1).
-- NO es la evidencia de cierre del P1 — esa viene de la validación adversarial
-- con conexiones Postgres reales, documentada por separado.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _diag_cobrar_cargo_lock()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid;
  v_auth uuid := gen_random_uuid();
  v_admin uuid;
  v_socio uuid;
  v_slug text := 'zz-p1lock-' || substr(md5(random()::text), 1, 6);
  v_cargo uuid;
  v_r1 jsonb; v_r2 jsonb;
  v_n int; v_estado text; v_ok boolean;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug, 'P1 Lock', 'gym_libre', 'activo') RETURNING id INTO v_tenant;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_slug||'-a@sala.dev',
          jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'), '', now(), now(), now());
  UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth RETURNING id INTO v_admin;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-s@x.dev','Socio','miembro','activo') RETURNING id INTO v_socio;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- T5a: cobro normal → success, exactamente 1 pago, cargo cobrado.
  INSERT INTO cargos_pendientes (tenant_id, usuario_id, concepto, descripcion, monto_centavos, estado)
  VALUES (v_tenant, v_socio, 'plan', 'Mensualidad', 50000, 'pendiente') RETURNING id INTO v_cargo;

  v_r1 := cobrar_cargo_pendiente(v_cargo, 'efectivo', gen_random_uuid());
  SELECT estado INTO v_estado FROM cargos_pendientes WHERE id = v_cargo;
  SELECT count(*) INTO v_n FROM pagos WHERE tenant_id=v_tenant AND concepto='plan';
  prueba := 'T5a. cobro normal → success, 1 pago, cargo cobrado';
  resultado := CASE WHEN (v_r1->>'success')::boolean IS TRUE AND v_estado='cobrado' AND v_n=1
    THEN '✅ ok' ELSE '❌ r1='||coalesce(v_r1::text,'?')||' estado='||coalesce(v_estado,'?')||' n='||v_n END;
  RETURN NEXT;

  -- T5b: segundo cobro secuencial sobre el mismo cargo ya cobrado → CARGO_NO_PENDIENTE,
  -- sin segundo pago (regresión del contrato del perdedor, sin cambios para el caller).
  v_ok := false;
  BEGIN
    PERFORM cobrar_cargo_pendiente(v_cargo, 'efectivo', gen_random_uuid());
  EXCEPTION WHEN raise_exception THEN
    v_ok := SQLERRM LIKE 'CARGO_NO_PENDIENTE%';
  END;
  SELECT count(*) INTO v_n FROM pagos WHERE tenant_id=v_tenant AND concepto='plan';
  prueba := 'T5b. segundo cobro secuencial → CARGO_NO_PENDIENTE, sigue 1 solo pago';
  resultado := CASE WHEN v_ok AND v_n=1 THEN '✅ ok' ELSE '❌ ok='||v_ok||' n='||v_n END;
  RETURN NEXT;

  -- T2: misma operation_key repetida/concurrente (aquí secuencial) → already_processed,
  -- sin tocar business_operations de forma distinta a como ya funcionaba.
  INSERT INTO cargos_pendientes (tenant_id, usuario_id, concepto, descripcion, monto_centavos, estado)
  VALUES (v_tenant, v_socio, 'plan', 'Mensualidad 2', 60000, 'pendiente') RETURNING id INTO v_cargo;
  DECLARE v_k uuid := gen_random_uuid();
  BEGIN
    v_r1 := cobrar_cargo_pendiente(v_cargo, 'efectivo', v_k);
    v_r2 := cobrar_cargo_pendiente(v_cargo, 'efectivo', v_k);
  END;
  SELECT count(*) INTO v_n FROM pagos WHERE tenant_id=v_tenant AND concepto='plan' AND monto_centavos=60000;
  prueba := 'T2. misma operation_key repetida → 1 pago, 2ª already_processed';
  resultado := CASE WHEN v_n=1 AND v_r2->>'status'='already_processed' AND (v_r1->>'pago_id')=(v_r2->>'pago_id')
    THEN '✅ ok' ELSE '❌ n='||v_n||' r2='||coalesce(v_r2->>'status','?') END;
  RETURN NEXT;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
  RETURN;
END $$;

SELECT * FROM _diag_cobrar_cargo_lock();
DROP FUNCTION _diag_cobrar_cargo_lock();
