-- ============================================================================
-- COBROS ONLINE (Stripe): atribuirlos a una sede
-- ----------------------------------------------------------------------------
-- EL HUECO: activar_suscripcion_socio (la RPC que corre el webhook de Stripe)
-- insertaba en `pagos` con sucursal_id = NULL, y creaba la membresía también sin
-- sede. Consecuencia: en un gym multi-sede, cuando el cobro real esté vivo, esos
-- pagos y esas membresías NO aparecerían en la vista por sucursal (Caja,
-- Reportes) — quedarían fuera de toda sede.
--
-- LA SEDE CORRECTA es la del SOCIO (usuarios.sucursal_id), que ya es la
-- semántica de membresias.sucursal_id ("la sede suscrita; backfill = la del
-- socio", 20260620100000). Así que acá:
--   1. la membresía nace con la sede del socio (y en renovación se completa si
--      estaba en NULL);
--   2. los dos asientos de `pagos` (plan/paquete + inscripción) llevan esa sede.
--
-- Es una función de la ruta del dinero, así que NO se reescribió a mano: se
-- extrajo su cuerpo vigente (20260715150000) y se parchearon SOLO 4 líneas
-- (columnas+valores del INSERT de membresía, una línea del UPDATE, y los dos
-- NULL de pagos). El diff se verificó línea por línea antes de pegarla.
--
-- Nota: `pagos` es append-only (UPDATE bloqueado por trigger), así que las filas
-- viejas con sucursal_id NULL no se pueden re-etiquetar. No hace falta: hoy no
-- hay cobros online (Stripe está diferido); esto arregla el camino hacia
-- adelante, para el día que se prenda.
-- ============================================================================

CREATE OR REPLACE FUNCTION activar_suscripcion_socio(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_stripe_subscription_id text DEFAULT NULL,
  p_stripe_customer_id text DEFAULT NULL,
  p_periodo_fin timestamptz DEFAULT NULL,
  -- Cobro real (lo informa el webhook de Stripe). NULL/0 → no registra dinero.
  p_monto_centavos integer DEFAULT NULL,
  p_referencia text DEFAULT NULL,
  p_inscripcion_centavos integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_commitment_meses integer;
  v_commitment_ends timestamptz;
  v_socio usuarios;
  v_tier tiers;
  v_now timestamptz := now();
  v_fin timestamptz;
  v_mem_id uuid;
  v_old_creditos integer;
  v_nuevo_creditos integer;
  v_es_paquete boolean;
  v_dias integer;
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

  v_es_paquete := v_tier.tipo IN ('creditos', 'hibrido') AND p_stripe_subscription_id IS NULL;

  -- Días de vigencia del plan. duracion_dias es la fuente de verdad (quincenal
  -- = 15); el periodo solo es el fallback histórico si la columna está vacía.
  v_dias := COALESCE(
    v_tier.duracion_dias,
    CASE v_tier.periodo
      WHEN 'anual'     THEN 365
      WHEN 'quincenal' THEN 15
      ELSE 30
    END
  );

  v_fin := CASE
    WHEN v_tier.tipo = 'hibrido'  THEN v_now + (v_dias || ' days')::interval
    WHEN v_tier.tipo = 'creditos' THEN NULL
    -- tipo='tiempo': manda el periodo que informa Stripe; si no vino (alta
    -- manual o pago único), se usa la vigencia REAL del plan.
    ELSE COALESCE(p_periodo_fin, v_now + (v_dias || ' days')::interval)
  END;

  SELECT id, creditos_restantes INTO v_mem_id, v_old_creditos
  FROM membresias
  WHERE usuario_id = p_usuario_id
    AND status IN ('activa', 'trialing', 'past_due', 'congelada')
  ORDER BY created_at DESC
  LIMIT 1;

  v_nuevo_creditos := CASE
    WHEN v_tier.tipo = 'tiempo' THEN NULL
    WHEN v_es_paquete           THEN COALESCE(v_old_creditos, 0) + COALESCE(v_tier.clases_incluidas, 0)
    ELSE COALESCE(v_tier.clases_incluidas, 0)
  END;

  -- PERMANENCIA: la decide el GYM, no el código. Antes se escribían 6 MESES
  -- fijos, ignorando `config.membresia.commitment_meses` (que el onboarding pone
  -- en 0 y nadie leía). Nada la enforzaba —no hay un solo RAISE— pero el admin SÍ
  -- la veía en la ficha del socio: el sistema le mostraba a cada gym una
  -- permanencia de medio año que jamás eligió. 0 o NULL = sin permanencia.
  SELECT COALESCE((config->'membresia'->>'commitment_meses')::integer, 0)
  INTO v_commitment_meses
  FROM tenants
  WHERE id = v_socio.tenant_id;

  v_commitment_ends := CASE
    WHEN COALESCE(v_commitment_meses, 0) > 0
      THEN v_now + (v_commitment_meses || ' months')::interval
    ELSE NULL
  END;

  IF v_mem_id IS NULL THEN
    INSERT INTO membresias (
      tenant_id, usuario_id, tier_id, sucursal_id, status,
      periodo_actual_inicio, periodo_actual_fin, commitment_ends_at,
      creditos_restantes, stripe_subscription_id, stripe_customer_id
    ) VALUES (
      v_socio.tenant_id, p_usuario_id, p_tier_id, v_socio.sucursal_id, 'activa',
      v_now, v_fin, v_commitment_ends,
      v_nuevo_creditos, p_stripe_subscription_id, p_stripe_customer_id
    )
    RETURNING id INTO v_mem_id;
  ELSE
    UPDATE membresias SET
      tier_id = p_tier_id,
      sucursal_id = COALESCE(sucursal_id, v_socio.sucursal_id),
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

  -- Ledger de créditos.
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

  -- ── DINERO (nuevo): registrar lo que Stripe cobró de verdad ───────────────
  IF COALESCE(p_monto_centavos, 0) > 0 THEN
    INSERT INTO pagos (
      tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
      concepto, monto_centavos, moneda, metodo, referencia, cobrado_por
    ) VALUES (
      v_socio.tenant_id, v_socio.sucursal_id, p_usuario_id, v_mem_id, p_tier_id,
      CASE WHEN v_es_paquete THEN 'paquete' ELSE 'plan' END,
      p_monto_centavos, COALESCE(v_tier.moneda, 'MXN'), 'stripe', p_referencia, NULL
    )
    ON CONFLICT DO NOTHING;  -- el webhook puede reintentar
  END IF;

  IF COALESCE(p_inscripcion_centavos, 0) > 0 THEN
    INSERT INTO pagos (
      tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
      concepto, monto_centavos, moneda, metodo, referencia, cobrado_por
    ) VALUES (
      v_socio.tenant_id, v_socio.sucursal_id, p_usuario_id, v_mem_id, p_tier_id,
      'inscripcion', p_inscripcion_centavos, COALESCE(v_tier.moneda, 'MXN'),
      'stripe', p_referencia, NULL
    )
    ON CONFLICT DO NOTHING;

    UPDATE usuarios
    SET inscripcion_pagada_at = COALESCE(inscripcion_pagada_at, v_now)
    WHERE id = p_usuario_id;
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

REVOKE ALL ON FUNCTION activar_suscripcion_socio(uuid, uuid, text, text, timestamptz, integer, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION activar_suscripcion_socio(uuid, uuid, text, text, timestamptz, integer, text, integer) FROM anon;
REVOKE ALL ON FUNCTION activar_suscripcion_socio(uuid, uuid, text, text, timestamptz, integer, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION activar_suscripcion_socio(uuid, uuid, text, text, timestamptz, integer, text, integer) TO service_role;


-- ============================================================================
-- SELF-TEST: un cobro online queda atribuido a la sede del socio.
-- ============================================================================
DO $$
DECLARE
  v_tenant uuid;
  v_suc uuid;
  v_socio uuid;
  v_tier uuid;
  v_res jsonb;
  v_slug text := 'zz-test-cobro-sede-' || substr(md5(random()::text), 1, 6);
  v_pagos_sin_sede integer;
  v_mem_suc uuid;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test cobro sede', 'gym_libre', 'activo')
  RETURNING id INTO v_tenant;

  INSERT INTO sucursales (tenant_id, nombre, timezone, activa, orden)
  VALUES (v_tenant, 'Sede Norte', 'America/Mexico_City', true, 0)
  RETURNING id INTO v_suc;

  -- El socio pertenece a esa sede: de ahí sale la atribución.
  INSERT INTO usuarios (tenant_id, sucursal_id, email, nombre, rol, status)
  VALUES (v_tenant, v_suc, v_slug || '-socio@sala.dev', 'Socio Online', 'miembro', 'activo')
  RETURNING id INTO v_socio;

  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, activo, orden)
  VALUES (v_tenant, 'mensual', 'Mensual', 'tiempo', 50000, 'MXN', true, 0)
  RETURNING id INTO v_tier;

  -- Simula el webhook de Stripe: cobra plan + inscripción.
  v_res := activar_suscripcion_socio(
    v_socio, v_tier, 'sub_test', 'cus_test', now() + interval '30 days',
    50000, 'sess_test_123', 10000
  );

  -- 1) Los DOS asientos (plan + inscripción) tienen que llevar la sede del socio.
  SELECT count(*) INTO v_pagos_sin_sede
  FROM pagos
  WHERE usuario_id = v_socio AND referencia = 'sess_test_123'
    AND (sucursal_id IS NULL OR sucursal_id <> v_suc);
  IF v_pagos_sin_sede > 0 THEN
    RAISE EXCEPTION 'FALLA: % asiento(s) de pago quedaron sin la sede del socio', v_pagos_sin_sede;
  END IF;

  IF (SELECT count(*) FROM pagos WHERE usuario_id = v_socio AND referencia = 'sess_test_123') <> 2 THEN
    RAISE EXCEPTION 'FALLA: se esperaban 2 asientos (plan + inscripción)';
  END IF;

  -- 2) La membresía también quedó atribuida a la sede.
  SELECT sucursal_id INTO v_mem_suc FROM membresias WHERE usuario_id = v_socio;
  IF v_mem_suc IS DISTINCT FROM v_suc THEN
    RAISE EXCEPTION 'FALLA: la membresía no quedó en la sede del socio';
  END IF;

  PERFORM cerrar_tenant(v_slug);
END;
$$;

SELECT 'el asiento del plan lleva la sede del socio' AS prueba, 'Sede Norte' AS espera, 'OK' AS resultado
UNION ALL SELECT 'el asiento de inscripción lleva la sede del socio', 'Sede Norte', 'OK'
UNION ALL SELECT 'la membresía creada por Stripe queda en la sede del socio', 'Sede Norte', 'OK';
