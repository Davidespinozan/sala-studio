-- ============================================================================
-- activar_suscripcion_socio — soporte de PAQUETES de clases (no solo mensualidad)
-- ----------------------------------------------------------------------------
-- Antes la vigencia salía siempre del periodo (mensual/anual) y los créditos se
-- RESETEABAN. Eso está bien para mensualidades y suscripciones de créditos, pero
-- mal para un PAQUETE de pago único. Ahora, según el tipo del tier:
--   · tiempo   → vigencia = periodo de Stripe o now + (mensual/anual); sin créditos.
--   · hibrido  → vigencia = now + duracion_dias (las clases vencen); créditos del pack.
--   · creditos → vigencia NULL (no vence por tiempo, se agota por créditos).
-- Y los créditos:
--   · paquete (pago único, sin suscripción) → SUMA al saldo (comprar otro acumula).
--   · suscripción de créditos               → RESET al cupo del periodo.
-- Es la función de 20260620220000 + esa lógica. No mueve dinero.
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
  v_old_creditos integer;
  v_nuevo_creditos integer;
  v_es_paquete boolean;  -- pago único (sin suscripción) de creditos/hibrido
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

  -- ¿Paquete de pago único? (creditos/hibrido sin suscripción de Stripe).
  v_es_paquete := v_tier.tipo IN ('creditos', 'hibrido') AND p_stripe_subscription_id IS NULL;

  -- Vigencia según el modelo del plan.
  v_fin := CASE
    WHEN v_tier.tipo = 'hibrido'  THEN v_now + (COALESCE(v_tier.duracion_dias, 30) || ' days')::interval
    WHEN v_tier.tipo = 'creditos' THEN NULL
    ELSE COALESCE(
      p_periodo_fin,
      v_now + (CASE WHEN v_tier.periodo = 'anual' THEN interval '1 year' ELSE interval '1 month' END)
    )
  END;

  -- Membresía vigente (para SUMAR créditos o renovar).
  SELECT id, creditos_restantes INTO v_mem_id, v_old_creditos
  FROM membresias
  WHERE usuario_id = p_usuario_id
    AND status IN ('activa', 'trialing', 'past_due', 'congelada')
  ORDER BY created_at DESC
  LIMIT 1;

  -- Créditos del nuevo estado.
  v_nuevo_creditos := CASE
    WHEN v_tier.tipo = 'tiempo' THEN NULL
    WHEN v_es_paquete           THEN COALESCE(v_old_creditos, 0) + COALESCE(v_tier.clases_incluidas, 0)
    ELSE COALESCE(v_tier.clases_incluidas, 0)
  END;

  IF v_mem_id IS NULL THEN
    INSERT INTO membresias (
      tenant_id, usuario_id, tier_id, status,
      periodo_actual_inicio, periodo_actual_fin, commitment_ends_at,
      creditos_restantes, stripe_subscription_id, stripe_customer_id
    ) VALUES (
      v_socio.tenant_id, p_usuario_id, p_tier_id, 'activa',
      v_now, v_fin, v_now + interval '6 months',
      v_nuevo_creditos, p_stripe_subscription_id, p_stripe_customer_id
    )
    RETURNING id INTO v_mem_id;
  ELSE
    UPDATE membresias SET
      tier_id = p_tier_id,
      status = 'activa',
      periodo_actual_inicio = v_now,
      periodo_actual_fin = v_fin,
      creditos_restantes = v_nuevo_creditos,
      stripe_subscription_id = COALESCE(p_stripe_subscription_id, stripe_subscription_id),
      stripe_customer_id = COALESCE(p_stripe_customer_id, stripe_customer_id),
      cancelada_at = NULL,
      cancelada_efectiva_at = NULL,
      updated_at = v_now
    WHERE id = v_mem_id;
  END IF;

  -- Ledger de créditos (alta si delta >= 0, ajuste si negativo).
  IF v_tier.tipo IN ('creditos', 'hibrido') THEN
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_socio.tenant_id,
      CASE WHEN COALESCE(v_nuevo_creditos, 0) - COALESCE(v_old_creditos, 0) >= 0 THEN 'alta' ELSE 'ajuste' END,
      COALESCE(v_nuevo_creditos, 0) - COALESCE(v_old_creditos, 0),
      NULL,
      CASE WHEN v_es_paquete THEN 'compra de paquete ' || v_tier.slug ELSE 'activación de plan ' || v_tier.slug END,
      p_usuario_id
    );
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
