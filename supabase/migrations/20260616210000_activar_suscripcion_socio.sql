-- ============================================================================
-- SUSCRIPCIÓN DEL SOCIO — RPC de activación (cableado para Stripe)
-- ----------------------------------------------------------------------------
-- Punto ÚNICO donde se materializa la membresía activa de un socio tras una
-- compra. Hoy lo invoca la function `suscribir-membresia` (pago simulado, solo
-- en el tenant demo); cuando se conecte Stripe, lo invocará el webhook
-- (checkout.session.completed / customer.subscription.updated) — misma firma,
-- pasando los IDs reales de Stripe.
--
-- A diferencia de gestionar_membresia_socio (que exige actor staff vía JWT),
-- este NO mira al actor: está pensado para ser llamado por el backend con
-- service_role (la function / el webhook). Por eso se OTORGA solo a service_role
-- — un socio nunca lo llama directo (no podría autoregalarse un plan).
--
-- Idempotente por diseño: si el socio ya tiene una membresía vigente, la RENUEVA
-- (extiende periodo + actualiza tier/stripe); si no, crea una nueva.
-- ============================================================================

CREATE OR REPLACE FUNCTION activar_suscripcion_socio(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_stripe_subscription_id text DEFAULT NULL,
  p_stripe_customer_id text DEFAULT NULL,
  p_periodo_fin timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_socio usuarios;
  v_tier tiers;
  v_now timestamptz := now();
  v_fin timestamptz;
  v_mem_id uuid;
BEGIN
  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE';
  END IF;
  IF v_socio.rol <> 'miembro' THEN
    RAISE EXCEPTION 'ROL_INVALIDO: solo socios pueden tener membresía';
  END IF;

  SELECT * INTO v_tier FROM tiers WHERE id = p_tier_id;
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE';
  END IF;
  IF v_tier.tenant_id <> v_socio.tenant_id THEN
    RAISE EXCEPTION 'TIER_DE_OTRO_TENANT';
  END IF;
  IF v_tier.activo IS NOT TRUE THEN
    RAISE EXCEPTION 'TIER_INACTIVO';
  END IF;

  -- Fin del periodo: el que mande Stripe, o calculado por el periodo del tier.
  v_fin := COALESCE(
    p_periodo_fin,
    v_now + (CASE WHEN v_tier.periodo = 'anual' THEN interval '1 year' ELSE interval '1 month' END)
  );

  -- ¿Tiene una membresía vigente? → renovar esa; si no, crear.
  SELECT id INTO v_mem_id
  FROM membresias
  WHERE usuario_id = p_usuario_id
    AND status IN ('activa', 'trialing', 'past_due', 'congelada')
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_mem_id IS NULL THEN
    INSERT INTO membresias (
      tenant_id, usuario_id, tier_id, status,
      periodo_actual_inicio, periodo_actual_fin, commitment_ends_at,
      stripe_subscription_id, stripe_customer_id
    ) VALUES (
      v_socio.tenant_id, p_usuario_id, p_tier_id, 'activa',
      v_now, v_fin, v_now + interval '6 months',
      p_stripe_subscription_id, p_stripe_customer_id
    )
    RETURNING id INTO v_mem_id;
  ELSE
    UPDATE membresias SET
      tier_id = p_tier_id,
      status = 'activa',
      periodo_actual_inicio = v_now,
      periodo_actual_fin = v_fin,
      stripe_subscription_id = COALESCE(p_stripe_subscription_id, stripe_subscription_id),
      stripe_customer_id = COALESCE(p_stripe_customer_id, stripe_customer_id),
      cancelada_at = NULL,
      cancelada_efectiva_at = NULL,
      updated_at = v_now
    WHERE id = v_mem_id;
  END IF;

  UPDATE usuarios SET
    membresia_activa_id = v_mem_id,
    membresia_tier = v_tier.slug,
    status = 'activo',
    stripe_customer_id = COALESCE(p_stripe_customer_id, stripe_customer_id),
    updated_at = v_now
  WHERE id = p_usuario_id;

  RETURN jsonb_build_object(
    'ok', true,
    'membresia_id', v_mem_id,
    'tier_slug', v_tier.slug,
    'periodo_fin', v_fin
  );
END;
$$;

-- Solo el backend (service_role) lo llama: la function del mock y el webhook de
-- Stripe. Ningún socio puede invocarlo directo para autoasignarse un plan.
REVOKE ALL ON FUNCTION activar_suscripcion_socio(uuid, uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION activar_suscripcion_socio(uuid, uuid, text, text, timestamptz) TO service_role;

COMMENT ON FUNCTION activar_suscripcion_socio(uuid, uuid, text, text, timestamptz) IS
  'Activa/renueva la membresía de un socio tras una compra. Lo llama el backend con service_role (function de checkout / webhook de Stripe). Cableado para Stripe: pasar stripe_subscription_id/customer_id/periodo_fin reales.';
