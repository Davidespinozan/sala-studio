-- ============================================================================
-- WAVE 5 · Extensiones W1/W2 en los RPC de ciclo de vida
-- ----------------------------------------------------------------------------
-- Cierra los huecos de idempotencia/lock que W1/W2 no alcanzaron en el ciclo de
-- vida de membresía (dedup del diseño W5):
--   · recepcion_cambiar_plan: gana p_operation_key (W1) — el bloque de
--     idempotencia va ANTES del chequeo TIER_IGUAL (que depende del estado) para
--     que un reintento converja en 'already_processed' y NO re-cambie ni re-cobre.
--   · recepcion_congelar / reactivar / cancelar: SELECT de la membresía con
--     FOR UPDATE OF m (W2) → serializa congelar-vs-cancelar / webhook-vs-manual.
-- Sin ningún otro cambio de comportamiento. Reproducción verbatim de la última
-- definición de cada RPC + el cambio puntual. BEGIN/COMMIT + self-tests.
-- No toca W3/W4, huella, ni las 31 divergencias.
-- ============================================================================

BEGIN;

-- ── recepcion_cambiar_plan — + p_operation_key (W1) ─────────────────────────
DROP FUNCTION IF EXISTS recepcion_cambiar_plan(uuid, uuid, text, text, integer, boolean);
CREATE OR REPLACE FUNCTION recepcion_cambiar_plan(
  p_usuario_id uuid,
  p_nuevo_tier_id uuid,
  p_motivo text,
  p_metodo_pago text DEFAULT NULL,
  p_monto_centavos integer DEFAULT NULL,
  p_confirmar_perdida boolean DEFAULT false,
  p_operation_key uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membresia_actual RECORD;
  v_tier_anterior_id uuid;
  v_socio_nombre text;
  v_resultado jsonb;
  v_op jsonb;
  v_owns boolean := false;
BEGIN
  -- Guard de tenant: un socio de otro tenant = "sin membresía" (sin oráculo).
  IF (SELECT tenant_id FROM usuarios WHERE id = p_usuario_id) IS DISTINCT FROM get_my_tenant_id() THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía previa para cambiar';
  END IF;

  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para cambiar de plan';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM tiers WHERE id = p_nuevo_tier_id) THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE: el nuevo plan no existe';
  END IF;

  -- Idempotencia (W1): ANTES de leer/validar el estado (TIER_IGUAL depende del
  -- estado, que cambia tras el 1er cambio). Un replay converge sin re-cambiar.
  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      get_my_tenant_id(), p_operation_key, 'membresia_cambio_plan', get_my_user_id(),
      md5(jsonb_build_object('usuario', p_usuario_id, 'tier', p_nuevo_tier_id,
                             'metodo', p_metodo_pago, 'monto', p_monto_centavos,
                             'confirmar', p_confirmar_perdida)::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  SELECT m.id, m.tier_id, u.nombre
  INTO v_membresia_actual
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  IF v_membresia_actual.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía previa para cambiar';
  END IF;

  v_tier_anterior_id := v_membresia_actual.tier_id;
  v_socio_nombre := v_membresia_actual.nombre;

  IF v_tier_anterior_id = p_nuevo_tier_id THEN
    RAISE EXCEPTION 'TIER_IGUAL: el nuevo plan es igual al actual. Usá renovar en su lugar';
  END IF;

  SELECT gestionar_membresia_socio(
    p_usuario_id, p_nuevo_tier_id, p_motivo, p_metodo_pago, p_monto_centavos,
    p_confirmar_perdida
  )
  INTO v_resultado;

  PERFORM _audrec_log(
    'membresia.cambiar_plan',
    'membresia',
    v_membresia_actual.id,
    p_usuario_id,
    v_socio_nombre,
    format('Cambió de plan. Motivo: %s', p_motivo),
    jsonb_build_object(
      'tier_anterior_id', v_tier_anterior_id,
      'tier_nuevo_id', p_nuevo_tier_id,
      'motivo', p_motivo,
      'metodo_pago', p_metodo_pago,
      'resultado', v_resultado
    )
  );

  IF v_owns THEN
    v_resultado := v_resultado || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(get_my_tenant_id(), p_operation_key, v_resultado);
  END IF;

  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_cambiar_plan(uuid, uuid, text, text, integer, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION recepcion_cambiar_plan(uuid, uuid, text, text, integer, boolean, uuid) TO authenticated;


-- ── recepcion_congelar_membresia — + FOR UPDATE OF m (W2) ───────────────────
CREATE OR REPLACE FUNCTION recepcion_congelar_membresia(
  p_usuario_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para congelar';
  END IF;

  SELECT m.id, m.status, m.tenant_id, u.nombre
  INTO v_mem
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  IF v_mem.status = 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_PAUSADA: la membresía ya estaba pausada';
  END IF;
  IF v_mem.status <> 'activa' THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_CONGELABLE: solo una membresía activa se puede pausar';
  END IF;

  UPDATE membresias
  SET status = 'congelada', congelada_at = now(), updated_at = now()
  WHERE id = v_mem.id;

  PERFORM _audrec_log(
    'membresia.congelar', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Pausó la membresía. Motivo: %s', p_motivo),
    jsonb_build_object('motivo', p_motivo, 'status_anterior', 'activa')
  );

  RETURN jsonb_build_object('success', true, 'status', 'congelada');
END;
$$;

REVOKE ALL ON FUNCTION recepcion_congelar_membresia(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_congelar_membresia(uuid, text) TO authenticated;


-- ── recepcion_reactivar_membresia — + FOR UPDATE OF m (W2) ──────────────────
-- (Última versión: revalida vencimiento → deja 'expirada' si sigue vencida.)
CREATE OR REPLACE FUNCTION recepcion_reactivar_membresia(
  p_usuario_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
  v_extension interval;
  v_dias numeric;
  v_nuevo_fin timestamptz;
  v_status_final text;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para reactivar';
  END IF;

  SELECT m.id, m.status, m.tenant_id, m.periodo_actual_fin, m.congelada_at, u.nombre
  INTO v_mem
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  IF v_mem.status <> 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_ACTIVA: la membresía no estaba pausada';
  END IF;

  v_extension := CASE
    WHEN v_mem.congelada_at IS NOT NULL THEN now() - v_mem.congelada_at
    ELSE interval '0'
  END;
  v_dias := round(extract(epoch FROM v_extension) / 86400.0, 1);

  v_nuevo_fin := CASE
    WHEN v_mem.periodo_actual_fin IS NOT NULL THEN v_mem.periodo_actual_fin + v_extension
    ELSE NULL
  END;
  v_status_final := CASE
    WHEN v_nuevo_fin IS NOT NULL AND v_nuevo_fin <= now() THEN 'expirada'
    ELSE 'activa'
  END;

  UPDATE membresias
  SET status = v_status_final,
      periodo_actual_fin = v_nuevo_fin,
      congelada_at = NULL,
      updated_at = now()
  WHERE id = v_mem.id;

  PERFORM _audrec_log(
    'membresia.reactivar', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Reactivó la membresía (se extendió el vencimiento %s días por la pausa)%s. Motivo: %s',
           v_dias,
           CASE WHEN v_status_final = 'expirada' THEN ' — quedó VENCIDA (ya estaba vencida al reactivar)' ELSE '' END,
           p_motivo),
    jsonb_build_object('motivo', p_motivo, 'status_anterior', 'congelada',
                       'status_final', v_status_final, 'dias_extendidos', v_dias)
  );

  RETURN jsonb_build_object('success', true, 'status', v_status_final, 'dias_extendidos', v_dias);
END;
$$;

REVOKE ALL ON FUNCTION recepcion_reactivar_membresia(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_reactivar_membresia(uuid, text) TO authenticated;


-- ── recepcion_cancelar_membresia — + FOR UPDATE OF m (W2) ───────────────────
CREATE OR REPLACE FUNCTION recepcion_cancelar_membresia(
  p_usuario_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_mem RECORD;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden esta acción';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para cancelar la membresía';
  END IF;

  SELECT m.id, m.status, m.tenant_id, u.nombre
  INTO v_mem
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía';
  END IF;
  IF v_mem.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese socio no pertenece a tu negocio';
  END IF;
  IF v_mem.status = 'cancelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_CANCELADA: la membresía ya estaba cancelada';
  END IF;

  UPDATE membresias
  SET status = 'cancelada', cancelada_at = now(), updated_at = now()
  WHERE id = v_mem.id;

  -- Cache: el trigger de W5-B también lo limpia; se mantiene por robustez.
  UPDATE usuarios
  SET membresia_tier = NULL, membresia_activa_id = NULL
  WHERE id = p_usuario_id;

  PERFORM _audrec_log(
    'membresia.cancelar', 'membresia', v_mem.id, p_usuario_id, v_mem.nombre,
    format('Canceló la membresía. Motivo: %s', p_motivo),
    jsonb_build_object('motivo', p_motivo, 'status_anterior', v_mem.status)
  );

  RETURN jsonb_build_object('success', true, 'status', 'cancelada');
END;
$$;

REVOKE ALL ON FUNCTION recepcion_cancelar_membresia(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_cancelar_membresia(uuid, text) TO authenticated;


-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — recep con auth + jwt; tenant desechable.
-- ============================================================================
CREATE TEMP TABLE _w5ext_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $$
DECLARE
  v_slug text := 'zz-w5ext-' || substr(md5(random()::text), 1, 6);
  v_tenant uuid; v_auth uuid := gen_random_uuid(); v_recep uuid;
  v_socio uuid; v_tierA uuid; v_tierB uuid; v_mem uuid;
  v_r jsonb; v_status text; v_tier uuid; v_key uuid := gen_random_uuid();
  v_ptr uuid;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug,'W5EXT','gym_libre','activo') RETURNING id INTO v_tenant;
  INSERT INTO auth.users (instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000',v_auth,'authenticated','authenticated',v_slug||'-r@test.local',
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('tenant_slug',v_slug,'nombre','Recep'),now(),now());
  UPDATE usuarios SET rol='recepcionista', status='activo' WHERE auth_id=v_auth RETURNING id INTO v_recep;
  IF v_recep IS NULL THEN RAISE EXCEPTION 'SETUP: no se creó la ficha recep'; END IF;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-s@test.local','Socio','miembro','activo') RETURNING id INTO v_socio;
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, duracion_dias) VALUES (v_tenant,'w5ext-a','A',100000,'tiempo',30) RETURNING id INTO v_tierA;
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, duracion_dias) VALUES (v_tenant,'w5ext-b','B',120000,'tiempo',30) RETURNING id INTO v_tierB;
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
  VALUES (v_tenant, v_socio, v_tierA, 'activa', now(), now()+interval '30 days') RETURNING id INTO v_mem;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- T1: congelar → reactivar (happy path con FOR UPDATE).
  v_r := recepcion_congelar_membresia(v_socio, 'pausa test');
  SELECT status INTO v_status FROM membresias WHERE id=v_mem;
  IF v_status <> 'congelada' THEN RAISE EXCEPTION 'T1: no congeló (=%)', v_status; END IF;
  v_r := recepcion_reactivar_membresia(v_socio, 'reactivar test');
  SELECT status INTO v_status FROM membresias WHERE id=v_mem;
  IF v_status <> 'activa' THEN RAISE EXCEPTION 'T1: no reactivó (=%)', v_status; END IF;
  INSERT INTO _w5ext_res VALUES (1, 'congelar/reactivar (FOR UPDATE) happy path', 'OK');

  -- T2: cambiar_plan idempotente — misma op_key dos veces = un solo cambio.
  v_r := recepcion_cambiar_plan(v_socio, v_tierB, 'cambio test', NULL, NULL, false, v_key);
  SELECT tier_id INTO v_tier FROM membresias WHERE usuario_id=v_socio AND status='activa' ORDER BY created_at DESC LIMIT 1;
  IF v_tier <> v_tierB THEN RAISE EXCEPTION 'T2: no cambió a B'; END IF;
  v_r := recepcion_cambiar_plan(v_socio, v_tierB, 'cambio test', NULL, NULL, false, v_key);
  IF (v_r->>'status') <> 'already_processed' THEN RAISE EXCEPTION 'T2: replay no convergió (=%)', v_r->>'status'; END IF;
  INSERT INTO _w5ext_res VALUES (2, 'cambiar_plan idempotente (replay=already_processed, sin TIER_IGUAL)', 'OK');

  -- T3: cancelar (FOR UPDATE) → cancelada + cache limpio.
  v_r := recepcion_cancelar_membresia(v_socio, 'baja test');
  SELECT status INTO v_status FROM membresias WHERE usuario_id=v_socio ORDER BY created_at DESC LIMIT 1;
  IF v_status <> 'cancelada' THEN RAISE EXCEPTION 'T3: no canceló (=%)', v_status; END IF;
  SELECT membresia_activa_id INTO v_ptr FROM usuarios WHERE id=v_socio;
  IF v_ptr IS NOT NULL THEN RAISE EXCEPTION 'T3: cache no quedó limpio tras cancelar'; END IF;
  INSERT INTO _w5ext_res VALUES (3, 'cancelar (FOR UPDATE) → cancelada + cache limpio', 'OK');

  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM cerrar_tenant(v_slug);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE;
END $$;

-- ── CONTRACT: W1/W2/W3/W4 + huella intactos ──────────────────────────────────
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='recepcion_cambiar_plan' ORDER BY oid DESC LIMIT 1;
  IF v_src IS NULL OR position('_op_begin' IN v_src)=0 THEN RAISE EXCEPTION 'CONTRATO: cambiar_plan sin op_key'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='recepcion_congelar_membresia' ORDER BY oid DESC LIMIT 1;
  IF v_src IS NULL OR position('FOR UPDATE OF m' IN v_src)=0 THEN RAISE EXCEPTION 'CONTRATO: congelar sin FOR UPDATE'; END IF;
  IF to_regclass('public.business_operations') IS NULL THEN RAISE EXCEPTION 'CONTRATO: W1 ausente'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='trg_membresia_credito_guard' ORDER BY oid DESC LIMIT 1;
  IF v_src IS NULL THEN RAISE EXCEPTION 'CONTRATO: W4-A5 ausente'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='check_in_por_huella') THEN RAISE EXCEPTION 'CONTRATO: huella ausente'; END IF;
  INSERT INTO _w5ext_res VALUES (4, 'contract: cambiar_plan op_key + congelar FOR UPDATE + W1/W4/huella', 'OK');
END $$;

SELECT orden, prueba, resultado FROM _w5ext_res ORDER BY orden;

COMMIT;
