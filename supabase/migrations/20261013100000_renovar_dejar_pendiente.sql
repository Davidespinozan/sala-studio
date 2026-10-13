-- ════════════════════════════════════════════════════════════════════════════
-- RENOVAR DEJANDO EL PAGO "POR COBRAR"
-- ────────────────────────────────────────────────────────────────────────────
-- Asignar plan ya permitía "Dejar pendiente (pagar al llegar)"; renovar no: la
-- única salida era "Sin registrar cobro", que no deja ni ingreso ni deuda. Lo
-- pidió numa (recepción renueva y el socio paga después).
--
-- recepcion_renovar_membresia gana p_dejar_pendiente + p_cargo_monto_centavos,
-- mismo patrón que recepcion_asignar_plan (D3 de wave1): renovar + cargo en UNA
-- transacción; si el cargo falla se cae también la renovación. La descripción
-- del cargo es el nombre del plan.
--
-- Defaults false/NULL: el frontend viejo (4 args con nombre) se comporta EXACTO
-- como hoy, así que esta migración se puede correr antes del deploy.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION IF EXISTS recepcion_renovar_membresia(uuid, text, text, integer, uuid);
CREATE OR REPLACE FUNCTION recepcion_renovar_membresia(
  p_usuario_id uuid,
  p_motivo text,
  p_metodo_pago text DEFAULT NULL,
  p_monto_centavos integer DEFAULT NULL,
  p_operation_key uuid DEFAULT NULL,
  p_dejar_pendiente boolean DEFAULT false,
  p_cargo_monto_centavos integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membresia_actual RECORD;
  v_socio_nombre text;
  v_resultado jsonb;
  v_cargo jsonb := NULL;
  v_tenant uuid := get_my_tenant_id();
  v_op jsonb;
  v_owns boolean := false;
BEGIN
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para renovar';
  END IF;
  -- Pendiente y cobrado a la vez sería registrar el dinero dos veces.
  IF p_dejar_pendiente AND p_metodo_pago IS NOT NULL THEN
    RAISE EXCEPTION 'PENDIENTE_CON_METODO: un pago pendiente no lleva método de pago';
  END IF;

  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'membresia_renovar', get_my_user_id(),
      md5(jsonb_build_object('usuario', p_usuario_id, 'motivo', p_motivo,
                             'metodo', p_metodo_pago, 'monto', p_monto_centavos,
                             'pendiente', p_dejar_pendiente,
                             'cargo_monto', p_cargo_monto_centavos)::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  SELECT m.id, m.tier_id, m.status, u.nombre, t.nombre AS tier_nombre
  INTO v_membresia_actual
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  LEFT JOIN tiers t ON t.id = m.tier_id
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
  ) INTO v_resultado;

  -- Dejar "por cobrar" — MISMA transacción. Si falla, se cae también la
  -- renovación. registrar_cargo_pendiente valida rol, tenant y monto > 0.
  IF p_dejar_pendiente THEN
    SELECT registrar_cargo_pendiente(
      p_usuario_id, p_cargo_monto_centavos, 'plan', v_membresia_actual.tier_nombre
    ) INTO v_cargo;
  END IF;

  PERFORM _audrec_log(
    'membresia.renovar', 'membresia', v_membresia_actual.id, p_usuario_id, v_socio_nombre,
    format('Renovó membresía. Motivo: %s', p_motivo),
    jsonb_build_object(
      'tier_id', v_membresia_actual.tier_id, 'motivo', p_motivo,
      'metodo_pago', p_metodo_pago, 'resultado', v_resultado,
      'cargo_pendiente', v_cargo
    )
  );

  v_resultado := v_resultado || jsonb_build_object('cargo_pendiente', v_cargo);
  IF v_owns THEN
    v_resultado := v_resultado || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_resultado);
  END IF;
  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_renovar_membresia(uuid, text, text, integer, uuid, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION recepcion_renovar_membresia(uuid, text, text, integer, uuid, boolean, integer) TO authenticated;

COMMIT;

-- Verificación (devuelve tabla): debe salir UNA fila, con los 7 argumentos.
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS argumentos
FROM pg_proc p
WHERE p.proname = 'recepcion_renovar_membresia';
