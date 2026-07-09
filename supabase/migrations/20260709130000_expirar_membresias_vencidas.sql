-- ============================================================================
-- Cron de expiración de membresías (antes solo había expiración "lazy", al
-- reservar/reactivar → dashboards y reportes reflejaban un plan que ya venció
-- porque el cache usuarios.membresia_tier seguía apuntando al plan viejo).
-- ----------------------------------------------------------------------------
-- expirar_membresias_vencidas() marca como 'expirada' toda membresía NO-Stripe
-- (las de Stripe las maneja el webhook: past_due / subscription.deleted) cuyo
-- periodo_actual_fin ya pasó, y —igual que una CANCELACIÓN— limpia el cache
-- usuarios.membresia_tier / membresia_activa_id del socio (ver recepcion_cancelar
-- _membresia, 20260613001100). NO toca usuarios.status (eso es "cuenta activa",
-- no "membresía vigente"), ni 'congelada' (pausada, reactivar recalcula), ni
-- 'pendiente'/'cancelada'/'expirada'. Planes de créditos (periodo_actual_fin
-- NULL) no vencen por tiempo → no se tocan.
-- Solo service_role (el cron cron-expirar-membresias). Devuelve el conteo.
-- ============================================================================

CREATE OR REPLACE FUNCTION expirar_membresias_vencidas()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH expiradas AS (
    UPDATE membresias
    SET status = 'expirada', updated_at = now()
    WHERE status IN ('activa', 'trialing', 'past_due')
      AND stripe_subscription_id IS NULL            -- Stripe → lo maneja el webhook
      AND periodo_actual_fin IS NOT NULL            -- NULL = plan sin vencimiento (créditos)
      AND periodo_actual_fin < now()
    RETURNING id, usuario_id
  ),
  limpiar_cache AS (
    -- Mismo efecto que cancelar: el badge/reportes leen usuarios.membresia_tier.
    -- Solo si la membresía vencida era la que el socio tenía como activa.
    UPDATE usuarios u
    SET membresia_tier = NULL, membresia_activa_id = NULL
    FROM expiradas e
    WHERE u.id = e.usuario_id
      AND u.membresia_activa_id = e.id
    RETURNING u.id
  )
  SELECT count(*) INTO v_count FROM expiradas;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION expirar_membresias_vencidas() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expirar_membresias_vencidas() TO service_role;

-- Primer barrido AHORA (arregla el backlog acumulado) + devuelve tabla de verificación.
SELECT expirar_membresias_vencidas() AS membresias_expiradas_ahora;
