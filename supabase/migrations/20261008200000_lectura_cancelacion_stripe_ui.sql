-- ════════════════════════════════════════════════════════════════════════════
-- LECTURA PARA UI DE CANCELACIÓN STRIPE (BLOCK 2D)
-- ────────────────────────────────────────────────────────────────────────────
-- Dos piezas de solo lectura, ninguna toca 1A/1B+1C/2A/2B/2C:
--
--   1) v_socio_membresia gana `stripe_subscription_id` — hoy la vista no lo
--      expone y el frontend no tiene forma de saber si una membresía es
--      Stripe-backed sin esto (necesario para decidir qué UI mostrar).
--      DROP+CREATE, mismo patrón que 20260930170000 (la migración que la
--      creó); mismos GRANTs, mismo security_invoker.
--
--   2) operacion_cancelacion_vigente(p_usuario_id): única forma de que la UI
--      sepa "hay una operación 'en_ejecucion' en este momento" sin depender
--      solo de la respuesta inmediata de la última acción (si el socio
--      recarga la página a mitad de una ambigüedad, debe seguir viendo
--      'procesando', no silencio). Self-scoped (socio sobre sí mismo) o
--      staff-scoped (recepción/admin sobre otro, mismo guard de sede que
--      iniciar_operacion_cancelacion ya usa). Jamás libera nada, solo lee.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

DROP VIEW IF EXISTS v_socio_membresia;

CREATE VIEW v_socio_membresia
WITH (security_invoker = true) AS
SELECT
  u.id            AS usuario_id,
  u.tenant_id     AS tenant_id,
  m.id            AS membresia_id,
  m.status        AS membresia_status,
  m.tier_id       AS tier_id,
  t.slug          AS tier_slug,
  t.nombre        AS tier_nombre,
  t.tipo          AS tier_tipo,
  t.duracion_dias AS duracion_dias,
  t.clases_incluidas AS clases_incluidas,
  t.es_pase       AS es_pase,
  t.acceso_todas_sucursales AS tier_acceso_todas_sucursales,
  m.periodo_actual_inicio,
  m.periodo_actual_fin,
  m.creditos_restantes,
  m.congelada_at,
  m.cancelada_at,
  m.cancelada_efectiva_at,
  m.sucursal_id,
  m.metodo_pago,
  m.stripe_subscription_id,
  es_membresia_vigente(m.status, m.periodo_actual_fin) AS vigente
FROM usuarios u
LEFT JOIN membresias m ON m.id = membresia_actual_id(u.id)
LEFT JOIN tiers t      ON t.id = m.tier_id
WHERE u.rol = 'miembro';

COMMENT ON VIEW v_socio_membresia IS
  'W5 + BLOCK2D. Autoridad canónica de lectura: 1 fila por socio con su membresía '
  'actual (membresia_actual_id) + vigente (es_membresia_vigente) + campos de '
  'display, incluido stripe_subscription_id (BLOCK2D, para que el frontend sepa '
  'si la membresía es Stripe-backed). Fuente única para '
  'useMembresiaActual/useSocioFicha/useSuscripcion/reportes. No rederivar '
  'vigencia en el front; el cache usuarios.* nunca es autoridad.';

GRANT SELECT ON v_socio_membresia TO authenticated;
GRANT SELECT ON v_socio_membresia TO service_role;

COMMIT;

-- ── Operación vigente (solo lectura) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION operacion_cancelacion_vigente(p_usuario_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor RECORD;
  v_target_usuario uuid;
  v_mem RECORD;
  v_op RECORD;
BEGIN
  SELECT id, tenant_id, rol, sucursal_id, status INTO v_actor
  FROM usuarios WHERE auth_id = auth.uid();
  IF v_actor.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_target_usuario := COALESCE(p_usuario_id, v_actor.id);

  IF v_target_usuario <> v_actor.id THEN
    IF v_actor.rol NOT IN ('recepcionista', 'admin') THEN
      RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden consultar la operación de otro socio';
    END IF;
  END IF;

  SELECT m.id, m.tenant_id, m.sucursal_id INTO v_mem
  FROM membresias m WHERE m.usuario_id = v_target_usuario
  ORDER BY m.created_at DESC LIMIT 1;

  IF v_mem.id IS NULL OR v_mem.tenant_id <> v_actor.tenant_id THEN
    RETURN NULL; -- sin membresía, o de otro tenant: no revela nada
  END IF;
  IF v_target_usuario <> v_actor.id THEN
    PERFORM _guard_sucursal_recepcion(v_mem.sucursal_id);
  END IF;

  SELECT op.id, op.accion, op.estado, op.creada_at INTO v_op
  FROM stripe_operaciones_cancelacion op
  WHERE op.membresia_id = v_mem.id AND op.estado = 'en_ejecucion'
  ORDER BY op.creada_at DESC LIMIT 1;

  IF v_op.id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'operacion_id', v_op.id, 'accion', v_op.accion, 'estado', v_op.estado, 'creada_at', v_op.creada_at
  );
END; $$;

REVOKE ALL ON FUNCTION operacion_cancelacion_vigente(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION operacion_cancelacion_vigente(uuid) TO authenticated, service_role;
