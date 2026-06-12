-- ============================================================================
-- RPCs wrapper de recepción  (Sub-round 2 · Fase 2 · Migración 2)
-- ----------------------------------------------------------------------------
-- Envuelven RPCs existentes (gestionar_membresia_socio, cancelar_reserva_atomic)
-- agregando escritura en auditoria_recepcion vía _audrec_log. Los RPCs
-- originales NO se tocan (admin los sigue usando intactos). El gate de rol lo
-- aplican los RPCs delegados + _audrec_log (todos exigen staff).
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC 1: recepcion_renovar_membresia — mismo tier, refresca período/saldo.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_renovar_membresia(
  p_usuario_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membresia_actual RECORD;
  v_socio_nombre text;
  v_resultado jsonb;
BEGIN
  -- Validar motivo
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para renovar';
  END IF;

  -- Obtener membresía actual del usuario (debe existir y tener tier)
  SELECT m.id, m.tier_id, m.status, u.nombre
  INTO v_membresia_actual
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('activa', 'expirada', 'past_due')
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_membresia_actual.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene una membresía renovable';
  END IF;

  v_socio_nombre := v_membresia_actual.nombre;

  -- Delegar al RPC existente con el MISMO tier (es renovación, no cambio)
  SELECT gestionar_membresia_socio(p_usuario_id, v_membresia_actual.tier_id, p_motivo)
  INTO v_resultado;

  -- Bitácora: verbo "membresia.renovar"
  PERFORM _audrec_log(
    'membresia.renovar',
    'membresia',
    v_membresia_actual.id,
    p_usuario_id,
    v_socio_nombre,
    format('Renovó membresía. Motivo: %s', p_motivo),
    jsonb_build_object(
      'tier_id', v_membresia_actual.tier_id,
      'motivo', p_motivo,
      'resultado', v_resultado
    )
  );

  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_renovar_membresia(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_renovar_membresia(uuid, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC 2: recepcion_cambiar_plan — tier distinto al actual.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_cambiar_plan(
  p_usuario_id uuid,
  p_nuevo_tier_id uuid,
  p_motivo text
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
BEGIN
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para cambiar de plan';
  END IF;

  -- Validar que el nuevo tier existe (mismo tenant del usuario, gestionar_membresia_socio
  -- ya valida el resto pero queremos error específico)
  IF NOT EXISTS (SELECT 1 FROM tiers WHERE id = p_nuevo_tier_id) THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE: el nuevo plan no existe';
  END IF;

  -- Membresía actual (cualquier status razonable; permite cambiar desde expirada también)
  SELECT m.id, m.tier_id, u.nombre
  INTO v_membresia_actual
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1;

  -- Si no tiene membresía previa, es un alta, no un cambio
  IF v_membresia_actual.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía previa para cambiar';
  END IF;

  v_tier_anterior_id := v_membresia_actual.tier_id;
  v_socio_nombre := v_membresia_actual.nombre;

  -- Si el tier es el mismo, esto es renovación, no cambio
  IF v_tier_anterior_id = p_nuevo_tier_id THEN
    RAISE EXCEPTION 'TIER_IGUAL: el nuevo plan es igual al actual. Usá renovar en su lugar';
  END IF;

  SELECT gestionar_membresia_socio(p_usuario_id, p_nuevo_tier_id, p_motivo)
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
      'resultado', v_resultado
    )
  );

  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_cambiar_plan(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_cambiar_plan(uuid, uuid, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC 3: recepcion_cancelar_reserva — cancela + devuelve crédito (vía wrapper).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_cancelar_reserva(
  p_reserva_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reserva RECORD;
  v_socio_nombre text;
  v_resultado jsonb;
BEGIN
  -- Motivo opcional en cancelar reserva (UX EKKO: aceptable).
  -- Si está vacío, lo seteamos a un texto genérico para que cancelar_reserva_atomic
  -- tenga algo que guardar en cancelada_motivo.
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    p_motivo := 'Cancelado por recepción';
  END IF;

  -- Capturar info de la reserva ANTES de cancelarla (para bitácora)
  SELECT r.id, r.status, r.usuario_id, u.nombre, r.slot_inicio, r.recurso_id
  INTO v_reserva
  FROM reservas r
  LEFT JOIN usuarios u ON u.id = r.usuario_id
  WHERE r.id = p_reserva_id;

  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: no encontramos esa reserva';
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'RESERVA_YA_CANCELADA: la reserva ya estaba cancelada';
  END IF;

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'RESERVA_NO_CANCELABLE: la reserva ya tiene check-in completado';
  END IF;

  v_socio_nombre := v_reserva.nombre;

  -- Delegar al RPC existente
  SELECT cancelar_reserva_atomic(p_reserva_id, p_motivo) INTO v_resultado;

  PERFORM _audrec_log(
    'reserva.cancelar',
    'reserva',
    p_reserva_id,
    v_reserva.usuario_id,
    v_socio_nombre,
    format('Canceló reserva del %s. Motivo: %s',
           to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI'),
           p_motivo),
    jsonb_build_object(
      'slot_inicio', v_reserva.slot_inicio,
      'recurso_id', v_reserva.recurso_id,
      'motivo', p_motivo,
      'status_anterior', v_reserva.status,
      'resultado', v_resultado
    )
  );

  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_cancelar_reserva(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_cancelar_reserva(uuid, text) TO authenticated;

-- ============================================================================
-- TEST integrado — solo recepcion_renovar_membresia (los otros 2 son el mismo
-- patrón). Savepoint + centinela 'ROLLBACK_TEST_2' revierte TODO: el cambio de
-- membresía, el movimiento de créditos y la fila de bitácora. Mismo patrón que
-- la migración 1 (sin WHEN others).
-- ============================================================================
DO $$
DECLARE
  v_recep        uuid;
  v_recep_auth   uuid;
  v_recep_tenant uuid;
  v_socio_id     uuid;
  v_socio_nombre text;
  v_pre  int;
  v_post int;
BEGIN
  -- Recepcionista con auth_id (para simular auth.uid()).
  SELECT id, auth_id, tenant_id
  INTO v_recep, v_recep_auth, v_recep_tenant
  FROM usuarios
  WHERE rol = 'recepcionista' AND auth_id IS NOT NULL
  LIMIT 1;

  IF v_recep IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay recepcionista con auth_id (los 3 RPCs quedaron creados + GRANT aplicado).';
    RETURN;
  END IF;

  -- Socio del MISMO tenant, con membresía renovable y tier ACTIVO (si no, SKIP).
  SELECT m.usuario_id, u.nombre
  INTO v_socio_id, v_socio_nombre
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  JOIN tiers t   ON t.id = m.tier_id AND t.activo
  WHERE u.tenant_id = v_recep_tenant
    AND u.rol = 'miembro'
    AND m.status IN ('activa', 'expirada', 'past_due')
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_socio_id IS NULL THEN
    RAISE NOTICE 'TEST SKIP: no hay socio con membresía renovable (tier activo) en el tenant del recepcionista (los 3 RPCs quedaron creados).';
    RETURN;
  END IF;

  SELECT count(*) INTO v_pre FROM auditoria_recepcion;

  BEGIN  -- ── subtransacción reversible ──────────────────────────────────────
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', v_recep_auth::text)::text,
      true
    );

    PERFORM recepcion_renovar_membresia(v_socio_id, 'Test: renovación integrada');

    SELECT count(*) INTO v_post FROM auditoria_recepcion;
    IF v_post <> v_pre + 1 THEN
      RAISE EXCEPTION 'TEST FAIL: no se insertó la fila de bitácora (pre=% post=%).', v_pre, v_post;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM auditoria_recepcion
      WHERE accion = 'membresia.renovar' AND socio_id = v_socio_id
    ) THEN
      RAISE EXCEPTION 'TEST FAIL: la fila no tiene accion=membresia.renovar / socio esperado.';
    END IF;

    -- Revertir TODO (membresía, movimientos, bitácora).
    RAISE EXCEPTION 'ROLLBACK_TEST_2';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_TEST_2' THEN
      NULL;  -- ok: subtransacción revertida
    ELSE
      RAISE;  -- un 'TEST FAIL …' / error real del RPC → aborta la migración
    END IF;
  END;

  -- Confirmar que no quedó residuo en la bitácora.
  SELECT count(*) INTO v_post FROM auditoria_recepcion;
  IF v_post <> v_pre THEN
    RAISE EXCEPTION 'TEST FAIL: la fila de prueba no se revirtió (pre=% post=%).', v_pre, v_post;
  END IF;

  RAISE NOTICE 'TEST OK ✔ recepcion_renovar_membresia delegó, escribió bitácora (membresia.renovar) y se revirtió (count sigue en %).', v_pre;
END $$;
