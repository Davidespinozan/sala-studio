-- ============================================================================
-- FIX (menor) — recepcion_renovar_membresia no encontraba una membresía pausada.
-- ----------------------------------------------------------------------------
-- El wrapper buscaba la membresía a renovar con status IN ('activa','expirada',
-- 'past_due'), excluyendo 'congelada'. Un socio con membresía pausada que quería
-- renovar daba MEMBRESIA_NO_EXISTE, aunque gestionar_membresia_socio (el RPC
-- delegado) sí soporta congelada y recepcion_recargar_creditos también la acepta.
-- Inconsistencia. Sumamos 'congelada' al lookup (renovar reactiva + renueva).
-- Recreado VERBATIM cambiando solo esa línea.
-- ============================================================================

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

  -- Obtener membresía actual del usuario (debe existir y tener tier).
  -- Incluye 'congelada': renovar una pausada la reactiva y renueva.
  SELECT m.id, m.tier_id, m.status, u.nombre
  INTO v_membresia_actual
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('activa', 'expirada', 'past_due', 'congelada')
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

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef('recepcion_renovar_membresia(uuid, text)'::regprocedure) INTO v_def;
  IF position('''congelada''' in v_def) = 0 THEN
    RAISE EXCEPTION 'TEST FALLO: recepcion_renovar_membresia no incluye congelada en el lookup.';
  END IF;
  RAISE NOTICE 'TEST OK: recepcion_renovar_membresia acepta membresía congelada.';
END $$;
