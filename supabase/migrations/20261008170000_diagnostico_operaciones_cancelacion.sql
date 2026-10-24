-- ════════════════════════════════════════════════════════════════════════════
-- DIAGNÓSTICO DE OPERACIONES ATASCADAS (BLOCK 2C — observabilidad mínima)
-- ────────────────────────────────────────────────────────────────────────────
-- Alcance: una sola RPC de solo lectura, admin-gated, tenant-scoped. NO libera
-- nada por TTL, NO toca Stripe, NO modifica ninguna fila. No es un panel
-- administrativo — es la mínima visibilidad para que un admin vea si hay
-- operaciones 'en_ejecucion' más viejas de lo esperado, con el id de la
-- operación y el tenant, para diagnosticar manualmente (Stripe dashboard con
-- el stripe_subscription_id, o reinvocando el reconciliador fuera de su
-- horario si hace falta con urgencia) sin que esto implemente ningún camino
-- de recuperación nuevo — la recuperación real sigue siendo exclusivamente
-- BLOCK 2B (reconciliar_operacion_cancelacion, con su doble lectura estable).
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION diagnostico_operaciones_atascadas(p_umbral_minutos integer DEFAULT 15)
RETURNS TABLE(
  operacion_id uuid,
  membresia_id uuid,
  accion text,
  actor_usuario_id uuid,
  actor_rol text,
  motivo text,
  stripe_subscription_id text,
  creada_at timestamptz,
  antiguedad_minutos numeric,
  reconciliador_ultima_revision timestamptz,
  reconciliador_ultima_lectura jsonb
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo un administrador puede ver este diagnóstico';
  END IF;

  RETURN QUERY
  SELECT
    op.id, op.membresia_id, op.accion, op.actor_usuario_id, op.actor_rol, op.motivo,
    m.stripe_subscription_id, op.creada_at,
    ROUND(EXTRACT(EPOCH FROM (now() - op.creada_at)) / 60, 1),
    op.reconciliador_ultima_revision, op.reconciliador_ultima_lectura
  FROM stripe_operaciones_cancelacion op
  JOIN membresias m ON m.id = op.membresia_id
  WHERE op.estado = 'en_ejecucion'
    AND op.tenant_id = get_my_tenant_id()
    AND op.creada_at < now() - (GREATEST(p_umbral_minutos, 1) || ' minutes')::interval
  ORDER BY op.creada_at ASC;
END; $$;

REVOKE ALL ON FUNCTION diagnostico_operaciones_atascadas(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION diagnostico_operaciones_atascadas(integer) TO authenticated, service_role;
