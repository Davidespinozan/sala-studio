-- ============================================================================
-- FIX: activar_suscripcion_socio no seteaba creditos_restantes.
-- ----------------------------------------------------------------------------
-- Para tiers tipo 'creditos'/'hibrido', la membresía nacía con creditos NULL →
-- el gate de reserva (COALESCE(creditos,0) <= 0) tiraba SIN_CREDITOS: el socio
-- "compraba" un plan que no podía usar. Ahora siembra los créditos del tier y
-- escribe un movimiento 'alta' en el ledger (igual que gestionar_membresia_socio).
-- Es la MISMA función de 20260616210000 + ese arreglo.
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
  v_old_creditos integer;   -- créditos antes (NULL si es alta nueva)
  v_nuevo_creditos integer; -- créditos del tier (NULL si tipo=tiempo)
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

  v_fin := COALESCE(
    p_periodo_fin,
    v_now + (CASE WHEN v_tier.periodo = 'anual' THEN interval '1 year' ELSE interval '1 month' END)
  );

  -- Créditos del periodo: NULL para tiempo (ilimitado por tiempo), el cupo del
  -- tier para creditos/hibrido. Activar = nuevo periodo → cupo fresco.
  v_nuevo_creditos := CASE WHEN v_tier.tipo = 'tiempo' THEN NULL ELSE COALESCE(v_tier.clases_incluidas, 0) END;

  -- ¿Tiene una membresía vigente? → renovar esa; si no, crear.
  SELECT id, creditos_restantes INTO v_mem_id, v_old_creditos
  FROM membresias
  WHERE usuario_id = p_usuario_id
    AND status IN ('activa', 'trialing', 'past_due', 'congelada')
  ORDER BY created_at DESC
  LIMIT 1;

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

  -- Ledger: un movimiento por el delta de créditos otorgados (solo tiers con
  -- créditos; tiempo no mueve saldo). Si el delta es negativo (renovación a un
  -- plan con menos cupo), va como 'ajuste' — la convención es que 'alta' nunca
  -- quede negativo (igual que gestionar_membresia_socio).
  IF v_tier.tipo IN ('creditos', 'hibrido') THEN
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_socio.tenant_id,
      CASE WHEN COALESCE(v_nuevo_creditos, 0) - COALESCE(v_old_creditos, 0) >= 0 THEN 'alta' ELSE 'ajuste' END,
      COALESCE(v_nuevo_creditos, 0) - COALESCE(v_old_creditos, 0),
      NULL, 'activación de plan ' || v_tier.slug, p_usuario_id
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
