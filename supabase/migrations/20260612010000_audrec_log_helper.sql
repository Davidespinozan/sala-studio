-- ============================================================================
-- Helper de bitácora: _audrec_log  (Sub-round 2 · Fase 2 · Migración 1)
-- ----------------------------------------------------------------------------
-- Fundación de la escritura en auditoria_recepcion. Los RPCs de acción de las
-- migraciones siguientes llaman a este helper en vez de repetir el INSERT y la
-- resolución del actor. SECURITY DEFINER: resuelve el actor desde el JWT
-- (auth.uid → usuarios), valida rol staff, e inserta la fila append-only.
-- (La tabla bloquea INSERT directo de clientes vía RLS; solo un DEFINER escribe.)
-- ============================================================================

CREATE OR REPLACE FUNCTION _audrec_log(
  p_accion text,
  p_entidad text,
  p_entidad_id uuid,
  p_socio_id uuid,
  p_socio_nombre text,
  p_resumen text,
  p_detalle jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
  v_actor_nombre text;
  v_actor_rol text;
  v_tenant_id uuid;
  v_id uuid;
BEGIN
  -- Resolver actor desde el JWT (auth.uid → usuarios).
  SELECT id, nombre, rol, tenant_id
  INTO v_actor_id, v_actor_nombre, v_actor_rol, v_tenant_id
  FROM usuarios
  WHERE auth_id = auth.uid()
  LIMIT 1;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: actor no encontrado en usuarios';
  END IF;

  -- Solo recepcionistas y admins pueden escribir bitácora.
  IF v_actor_rol NOT IN ('recepcionista', 'admin') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: rol % no puede escribir bitácora', v_actor_rol;
  END IF;

  INSERT INTO auditoria_recepcion (
    tenant_id, actor_id, actor_nombre, actor_rol,
    accion, entidad, entidad_id,
    socio_id, socio_nombre,
    resumen, detalle
  ) VALUES (
    v_tenant_id, v_actor_id, v_actor_nombre, v_actor_rol,
    p_accion, p_entidad, p_entidad_id,
    p_socio_id, p_socio_nombre,
    p_resumen, COALESCE(p_detalle, '{}'::jsonb)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION _audrec_log(text, text, uuid, uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _audrec_log(text, text, uuid, uuid, text, text, jsonb) TO authenticated;

COMMENT ON FUNCTION _audrec_log(text, text, uuid, uuid, text, text, jsonb) IS
  'Inserta una fila en auditoria_recepcion resolviendo el actor desde el JWT. SECURITY DEFINER; lo llaman los RPCs de acción de recepción/admin. La tabla es append-only (triggers) y solo admin la lee (RLS).';

-- ============================================================================
-- TEST integrado — OPCIÓN A: el INSERT de prueba se revierte con una
-- SUBTRANSACCIÓN (BEGIN…EXCEPTION = savepoint implícito) + excepción centinela,
-- mismo patrón que 20260611. Así auditoria_recepcion queda en su count previo
-- (0 en limpio) sin pelear con el trigger anti-DELETE. Si algo falla de verdad,
-- aborta la migración (no se usa WHEN others: cada excepción esperada se atrapa
-- por su clase; cualquier otra burbujea).
-- ============================================================================
DO $$
DECLARE
  v_recep uuid;
  v_recep_auth uuid;
  v_socio uuid;
  v_socio_nombre text;
  v_audit_id uuid;
  v_pre int;
  v_post int;
BEGIN
  -- Primer recepcionista CON auth_id (lo necesitamos para simular auth.uid()).
  SELECT id, auth_id INTO v_recep, v_recep_auth
  FROM usuarios
  WHERE rol = 'recepcionista' AND auth_id IS NOT NULL
  LIMIT 1;

  IF v_recep IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay recepcionista con auth_id en la DB (el helper igual quedó creado + GRANT aplicado).';
    RETURN;
  END IF;

  SELECT id, nombre INTO v_socio, v_socio_nombre FROM usuarios WHERE rol = 'miembro' LIMIT 1;

  SELECT count(*) INTO v_pre FROM auditoria_recepcion;

  BEGIN  -- ── subtransacción reversible ──────────────────────────────────────
    -- Simular el JWT del recepcionista → auth.uid() lo resuelve dentro del helper.
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', v_recep_auth::text)::text,
      true
    );

    v_audit_id := _audrec_log(
      'membresia.renovar',
      'membresia',
      gen_random_uuid(),
      v_socio,
      COALESCE(v_socio_nombre, 'Test Socio'),
      'Test: renovación de prueba',
      '{"test": true}'::jsonb
    );

    SELECT count(*) INTO v_post FROM auditoria_recepcion;
    IF v_post <> v_pre + 1 THEN
      RAISE EXCEPTION 'TEST FAIL: el helper no insertó (pre=% post=%).', v_pre, v_post;
    END IF;

    -- Revertir la fila de prueba: excepción centinela → rollback de la subtx.
    RAISE EXCEPTION 'ROLLBACK_AUDREC_TEST';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_AUDREC_TEST' THEN
      NULL;  -- ok: la subtransacción y su fila de prueba se revirtieron
    ELSE
      RAISE;  -- un 'TEST FAIL …' / 'NO_AUTORIZADO …' real → aborta la migración
    END IF;
  END;

  -- Confirmar que no quedó residuo.
  SELECT count(*) INTO v_post FROM auditoria_recepcion;
  IF v_post <> v_pre THEN
    RAISE EXCEPTION 'TEST FAIL: la fila de prueba no se revirtió (pre=% post=%).', v_pre, v_post;
  END IF;

  RAISE NOTICE 'TEST OK ✔ _audrec_log resolvió el actor, insertó la fila, y se revirtió (auditoria_recepcion sigue en count=%).', v_pre;
END $$;
