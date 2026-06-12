-- ============================================================================
-- recepcion_asignar_plan + verbo 'membresia.alta'  (Sub-round 2 · Fase 3 · Hotfix)
-- ----------------------------------------------------------------------------
-- Alta del PRIMER plan de un socio (sin membresía renovable previa). Delega en
-- gestionar_membresia_socio (que crea la membresía) + bitácora.
--
-- Se agrega el verbo 'membresia.alta' al CHECK de auditoria_recepcion.accion
-- (usar 'membresia.renovar' para un alta ensuciaría la bitácora). Mismo patrón
-- de introspección del conkey que la migración 4; se reproduce la lista FULL
-- (corre después de 20260612040000, que ya sumó 'checkin.corregir').
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Extender el enum de accion con 'membresia.alta'.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_attnum smallint;
  v_name text;
BEGIN
  SELECT attnum INTO v_attnum
  FROM pg_attribute
  WHERE attrelid = 'auditoria_recepcion'::regclass
    AND attname = 'accion'
    AND NOT attisdropped;

  SELECT conname INTO v_name
  FROM pg_constraint
  WHERE conrelid = 'auditoria_recepcion'::regclass
    AND contype = 'c'
    AND conkey = ARRAY[v_attnum]::int2[]
  LIMIT 1;

  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE auditoria_recepcion DROP CONSTRAINT %I', v_name);
  END IF;
END $$;

ALTER TABLE auditoria_recepcion ADD CONSTRAINT auditoria_recepcion_accion_check
  CHECK (accion IN (
    'membresia.alta','membresia.renovar','membresia.cambiar_plan','membresia.recargar_creditos',
    'membresia.congelar','membresia.reactivar','membresia.cancelar',
    'reserva.crear','reserva.cancelar','reserva.lista_espera_anotar','reserva.lista_espera_promover',
    'socio.crear','socio.editar_contacto','socio.reset_password','socio.bloquear','socio.desbloquear','socio.nota',
    'clase.crear','clase.cancelar','clase.reasignar_coach','clase.marcar_asistencia','clase.marcar_no_show',
    'pago.reenviar_link','pago.activar',
    'checkin.manual','checkin.qr','checkin.corregir'
  ));

-- ─────────────────────────────────────────────────────────────────────────────
-- recepcion_asignar_plan
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_asignar_plan(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_socio_nombre text;
  v_tiene_membresia boolean;
  v_mem_id uuid;
  v_resultado jsonb;
BEGIN
  -- Gate
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin';
  END IF;

  -- Validar motivo
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio';
  END IF;

  -- Validar tier
  IF NOT EXISTS (SELECT 1 FROM tiers WHERE id = p_tier_id) THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE: el plan no existe';
  END IF;

  -- Verificar que NO tiene membresía previa renovable (si la tiene, usar
  -- cambiar_plan o renovar).
  SELECT EXISTS (
    SELECT 1 FROM membresias
    WHERE usuario_id = p_usuario_id
      AND status IN ('activa', 'congelada', 'past_due')
  ) INTO v_tiene_membresia;

  IF v_tiene_membresia THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_EXISTE: el socio ya tiene una membresía activa o pausada. Usá cambiar plan en su lugar';
  END IF;

  -- Capturar nombre del socio para bitácora
  SELECT nombre INTO v_socio_nombre FROM usuarios WHERE id = p_usuario_id;

  IF v_socio_nombre IS NULL THEN
    RAISE EXCEPTION 'SOCIO_NO_EXISTE: el socio no existe';
  END IF;

  -- Delegar al RPC base (crea/activa la membresía; valida tenant + tier activo).
  SELECT gestionar_membresia_socio(p_usuario_id, p_tier_id, p_motivo)
  INTO v_resultado;

  -- Id de la membresía recién creada (para entidad_id de la bitácora).
  SELECT id INTO v_mem_id
  FROM membresias
  WHERE usuario_id = p_usuario_id
  ORDER BY created_at DESC
  LIMIT 1;

  PERFORM _audrec_log(
    'membresia.alta',
    'membresia',
    v_mem_id,
    p_usuario_id,
    v_socio_nombre,
    format('Asignó nuevo plan al socio. Motivo: %s', p_motivo),
    jsonb_build_object(
      'tier_id', p_tier_id,
      'motivo', p_motivo,
      'tipo', 'alta_inicial',
      'resultado', v_resultado
    )
  );

  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_asignar_plan(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_asignar_plan(uuid, uuid, text) TO authenticated;
