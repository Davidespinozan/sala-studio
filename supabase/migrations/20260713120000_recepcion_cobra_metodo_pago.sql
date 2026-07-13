-- ============================================================================
-- ETAPA 3/3 (DB) — recepción informa el MÉTODO DE PAGO al asignar/renovar/cambiar.
-- ----------------------------------------------------------------------------
-- gestionar_membresia_socio ya sabe registrar el cobro en `pagos` (etapa 2), pero
-- los tres wrappers de recepción lo llamaban con 3 argumentos y nunca le pasaban
-- el método → ningún cobro de mostrador quedaba registrado.
--
-- Los params nuevos son OPCIONALES (default NULL): sin método, se comporta igual
-- que antes (asigna el plan y no mueve dinero) — eso cubre las cortesías.
-- ============================================================================

-- Firmas viejas fuera (si no, quedan overloads ambiguos para PostgREST).
DROP FUNCTION IF EXISTS recepcion_asignar_plan(uuid, uuid, text);
DROP FUNCTION IF EXISTS recepcion_renovar_membresia(uuid, text);
DROP FUNCTION IF EXISTS recepcion_cambiar_plan(uuid, uuid, text);

-- ── recepcion_asignar_plan ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_asignar_plan(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_motivo text,
  p_metodo_pago text DEFAULT NULL,
  p_monto_centavos integer DEFAULT NULL
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
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin';
  END IF;

  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM tiers WHERE id = p_tier_id) THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE: el plan no existe';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM membresias
    WHERE usuario_id = p_usuario_id
      AND status IN ('activa', 'congelada', 'past_due')
  ) INTO v_tiene_membresia;

  IF v_tiene_membresia THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_EXISTE: el socio ya tiene una membresía activa o pausada. Usá cambiar plan en su lugar';
  END IF;

  SELECT nombre INTO v_socio_nombre FROM usuarios WHERE id = p_usuario_id;
  IF v_socio_nombre IS NULL THEN
    RAISE EXCEPTION 'SOCIO_NO_EXISTE: el socio no existe';
  END IF;

  -- Delega al motor: crea la membresía Y registra el cobro (plan + inscripción).
  SELECT gestionar_membresia_socio(p_usuario_id, p_tier_id, p_motivo, p_metodo_pago, p_monto_centavos)
  INTO v_resultado;

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
      'metodo_pago', p_metodo_pago,
      'resultado', v_resultado
    )
  );

  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_asignar_plan(uuid, uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_asignar_plan(uuid, uuid, text, text, integer) TO authenticated;

-- ── recepcion_renovar_membresia ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_renovar_membresia(
  p_usuario_id uuid,
  p_motivo text,
  p_metodo_pago text DEFAULT NULL,
  p_monto_centavos integer DEFAULT NULL
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
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para renovar';
  END IF;

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

  SELECT gestionar_membresia_socio(
    p_usuario_id, v_membresia_actual.tier_id, p_motivo, p_metodo_pago, p_monto_centavos
  )
  INTO v_resultado;

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
      'metodo_pago', p_metodo_pago,
      'resultado', v_resultado
    )
  );

  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_renovar_membresia(uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_renovar_membresia(uuid, text, text, integer) TO authenticated;

-- ── recepcion_cambiar_plan ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recepcion_cambiar_plan(
  p_usuario_id uuid,
  p_nuevo_tier_id uuid,
  p_motivo text,
  p_metodo_pago text DEFAULT NULL,
  p_monto_centavos integer DEFAULT NULL
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

  IF NOT EXISTS (SELECT 1 FROM tiers WHERE id = p_nuevo_tier_id) THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE: el nuevo plan no existe';
  END IF;

  SELECT m.id, m.tier_id, u.nombre
  INTO v_membresia_actual
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_membresia_actual.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene membresía previa para cambiar';
  END IF;

  v_tier_anterior_id := v_membresia_actual.tier_id;
  v_socio_nombre := v_membresia_actual.nombre;

  IF v_tier_anterior_id = p_nuevo_tier_id THEN
    RAISE EXCEPTION 'TIER_IGUAL: el nuevo plan es igual al actual. Usá renovar en su lugar';
  END IF;

  SELECT gestionar_membresia_socio(
    p_usuario_id, p_nuevo_tier_id, p_motivo, p_metodo_pago, p_monto_centavos
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

  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_cambiar_plan(uuid, uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recepcion_cambiar_plan(uuid, uuid, text, text, integer) TO authenticated;

-- ============================================================================
-- SELF-TEST — devuelve TABLA.
-- ============================================================================
WITH checks AS (
  SELECT 'recepcion_asignar_plan acepta método de pago (5 args)' AS prueba,
         EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'recepcion_asignar_plan' AND pronargs = 5) AS ok
  UNION ALL
  SELECT 'recepcion_renovar_membresia acepta método de pago (4 args)',
         EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'recepcion_renovar_membresia' AND pronargs = 4)
  UNION ALL
  SELECT 'recepcion_cambiar_plan acepta método de pago (5 args)',
         EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'recepcion_cambiar_plan' AND pronargs = 5)
  UNION ALL
  SELECT 'sin overloads viejos de los wrappers',
         NOT EXISTS (
           SELECT 1 FROM pg_proc
           WHERE (proname = 'recepcion_asignar_plan'      AND pronargs = 3)
              OR (proname = 'recepcion_renovar_membresia' AND pronargs = 2)
              OR (proname = 'recepcion_cambiar_plan'      AND pronargs = 3)
         )
  UNION ALL
  SELECT 'los 3 wrappers pasan el método al motor de cobro',
         (SELECT bool_and(pg_get_functiondef(oid) LIKE '%p_metodo_pago, p_monto_centavos%')
            FROM pg_proc
           WHERE proname IN ('recepcion_asignar_plan', 'recepcion_renovar_membresia', 'recepcion_cambiar_plan'))
)
SELECT CASE WHEN ok THEN '✅' ELSE '❌' END AS estado, prueba
FROM checks
ORDER BY ok, prueba;
