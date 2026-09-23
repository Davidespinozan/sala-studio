-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- El cron de expiración deja ASIENTO en el ledger de créditos (auditoría)
-- ----------------------------------------------------------------------------
-- expirar_membresias_vencidas() ponía creditos_restantes = 0 al vencer, pero SIN
-- registrar un movimiento → SUM(membresia_movimientos.delta_creditos) dejaba de
-- cuadrar con creditos_restantes (el motor gestionar_membresia_socio SÍ registra la
-- expiración en cambio_de_tipo; el cron no lo hacía). No afecta dinero real (es el
-- ledger de créditos, no `pagos`), solo la conciliación/auditoría.
--
-- Fix: antes de poner en 0, se inserta un movimiento tipo 'expiracion' (delta = el
-- crédito sobrante en negativo) por cada membresía que caduca con crédito > 0.
-- Seguro: el único trigger de membresia_movimientos es BEFORE UPDATE (no dispara en
-- INSERT); 'expiracion' es un tipo válido del CHECK; created_by NULL (cron sin auth).
-- Solo aplica hacia adelante; los ya-expirados históricos no se re-asientan.
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
  -- Asiento de expiración de créditos ANTES de ponerlos en 0 (para que el ledger
  -- cuadre). Solo las que caducan con crédito sobrante.
  INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, motivo, created_by)
  SELECT m.id, m.tenant_id, 'expiracion', -m.creditos_restantes,
         'créditos caducados al vencer la vigencia', NULL
  FROM membresias m
  WHERE m.status IN ('activa', 'trialing', 'past_due')
    AND m.stripe_subscription_id IS NULL
    AND m.periodo_actual_fin IS NOT NULL
    AND m.periodo_actual_fin < now()
    AND COALESCE(m.creditos_restantes, 0) > 0;

  WITH expiradas AS (
    UPDATE membresias
    SET status = 'expirada',
        -- Los créditos sobrantes CADUCAN con la vigencia (regla del dueño).
        creditos_restantes = CASE WHEN creditos_restantes IS NOT NULL THEN 0 ELSE NULL END,
        updated_at = now()
    WHERE status IN ('activa', 'trialing', 'past_due')
      AND stripe_subscription_id IS NULL            -- Stripe → lo maneja el webhook
      AND periodo_actual_fin IS NOT NULL            -- NULL = plan sin vencimiento
      AND periodo_actual_fin < now()
    RETURNING id, usuario_id
  ),
  limpiar_cache AS (
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

-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA.
--   1) Al vencer una membresía de créditos: status='expirada', creditos=0, Y queda
--      un movimiento tipo 'expiracion' con delta = -(crédito sobrante).
-- Corre dentro de un sub-bloque que se revierte.
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_cron_asiento()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_socio uuid; v_tier uuid; v_mem uuid;
  v_status text; v_cred integer; v_delta integer; v_n integer;
  v_out text := '(no corrió)';
BEGIN
  BEGIN
    SELECT id INTO v_tenant FROM tenants WHERE status = 'activo' ORDER BY created_at LIMIT 1;

    INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
    VALUES (v_tenant, 'cron-asiento-test@example.com', 'Cron Asiento Test', 'miembro', 'activo')
    RETURNING id INTO v_socio;

    INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, clases_incluidas, activo, orden)
    VALUES (v_tenant, 'cron-asiento-test', 'Cron Asiento Test', 'creditos', 10000, 'MXN', 7, 5, true, 999)
    RETURNING id INTO v_tier;

    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status,
                            periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
    VALUES (v_tenant, v_socio, v_tier, 'activa',
            now() - interval '14 days', now() - interval '3 days', 3)
    RETURNING id INTO v_mem;

    PERFORM expirar_membresias_vencidas();

    SELECT status, creditos_restantes INTO v_status, v_cred FROM membresias WHERE id = v_mem;
    SELECT count(*), COALESCE(SUM(delta_creditos), 0) INTO v_n, v_delta
    FROM membresia_movimientos WHERE membresia_id = v_mem AND tipo = 'expiracion';

    IF v_status = 'expirada' AND COALESCE(v_cred, -1) = 0 AND v_n = 1 AND v_delta = -3 THEN
      v_out := '✅ expirada, créditos 0, asiento expiracion delta -3';
    ELSE
      v_out := format('❌ status=%s cred=%s asientos=%s delta=%s', v_status, v_cred, v_n, v_delta);
    END IF;

    RAISE EXCEPTION 'ROLLBACK_CA';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_CA' THEN v_out := '❌ montaje falló: ' || SQLERRM; END IF;
  END;

  prueba := '1. cron deja asiento de expiración en el ledger de créditos';
  resultado := v_out; RETURN NEXT;
  RETURN;
END $$;

SELECT * FROM _diag_cron_asiento();
DROP FUNCTION _diag_cron_asiento();
