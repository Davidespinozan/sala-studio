-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Al VENCER un plan, los créditos NO usados también CADUCAN (paso 3)
-- ----------------------------------------------------------------------------
-- Regla (dueño): el socio tiene un tiempo determinado (la vigencia del plan) para
-- consumir sus créditos; lo que no usó, SE PIERDE al vencer. Hoy
-- expirar_membresias_vencidas() solo marcaba status='expirada' y dejaba
-- creditos_restantes intacto → un plan vencido seguía mostrando crédito (caso
-- Brianda: Híbrido vencido el 8-ago con 1 crédito colgando).
--
-- POR QUÉ ES SEGURO (no le quita nada a una reserva ya hecha):
--   · El crédito se DEBITA al RESERVAR (reservar_clase_atomic:
--     creditos_restantes = creditos_restantes - 1). Entonces creditos_restantes es
--     el SOBRANTE que todavía no se convirtió en reserva.
--   · Ponerlo en 0 al vencer solo borra ese sobrante. Las reservas ya hechas ya
--     gastaron su crédito y se respetan en el check-in (ver 20260819130000).
--   · Los planes es_pase con reserva a futuro NO llegan a vencer acá: el trigger
--     pase_sigue_a_reserva les extiende la vigencia hasta el día de la clase.
--   · No hay trigger que ate creditos_restantes al ledger, así que el UPDATE
--     directo es válido (igual que el cron ya hacía con status).
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


-- ── Barrido RETROACTIVO (una vez) ───────────────────────────────────────────
-- Las membresías que YA estaban 'expirada' con crédito sobrante (como Brianda) no
-- las vuelve a tocar el cron (ya salieron de 'activa/trialing/past_due'). Se
-- limpian aquí, una sola vez.
UPDATE membresias
SET creditos_restantes = 0, updated_at = now()
WHERE status = 'expirada'
  AND creditos_restantes IS NOT NULL
  AND creditos_restantes <> 0;


-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA.
--   1) Una membresía de créditos VENCIDA (periodo pasado) al correr el cron queda
--      status='expirada' Y creditos_restantes=0.
--   2) Post-barrido: NINGUNA membresía 'expirada' conserva crédito sobrante.
-- El caso 1 corre dentro de un sub-bloque que se revierte.
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_creditos_caducan()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_socio uuid; v_tier uuid; v_mem uuid;
  v_status text; v_cred integer;
  v_forward text := '(no corrió)';
  v_colgando integer;
BEGIN
  BEGIN
    SELECT id INTO v_tenant FROM tenants WHERE status = 'activo' ORDER BY created_at LIMIT 1;

    INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
    VALUES (v_tenant, 'creditos-caducan-test@example.com', 'Creditos Caducan Test', 'miembro', 'activo')
    RETURNING id INTO v_socio;

    INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, clases_incluidas, activo, orden)
    VALUES (v_tenant, 'creditos-caducan-test', 'Creditos Caducan Test', 'creditos', 10000, 'MXN', 7, 5, true, 999)
    RETURNING id INTO v_tier;

    -- Membresía de créditos ACTIVA pero con el periodo YA vencido y 3 créditos sin usar.
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status,
                            periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
    VALUES (v_tenant, v_socio, v_tier, 'activa',
            now() - interval '14 days', now() - interval '3 days', 3)
    RETURNING id INTO v_mem;

    PERFORM expirar_membresias_vencidas();

    SELECT status, creditos_restantes INTO v_status, v_cred FROM membresias WHERE id = v_mem;
    IF v_status = 'expirada' AND COALESCE(v_cred, -1) = 0 THEN
      v_forward := '✅ queda expirada y créditos en 0';
    ELSE
      v_forward := format('❌ status=%s creditos=%s', v_status, v_cred);
    END IF;

    RAISE EXCEPTION 'ROLLBACK_CC';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_CC' THEN v_forward := '❌ montaje falló: ' || SQLERRM; END IF;
  END;

  SELECT count(*) INTO v_colgando
  FROM membresias
  WHERE status = 'expirada' AND creditos_restantes IS NOT NULL AND creditos_restantes <> 0;

  prueba := '1. vencer una membresía de créditos → status expirada + créditos 0';
  resultado := v_forward; RETURN NEXT;
  prueba := '2. membresías expiradas que TODAVÍA tienen crédito colgando (debe ser 0)';
  resultado := CASE WHEN v_colgando = 0 THEN '✅ 0' ELSE '❌ quedan ' || v_colgando END;
  RETURN NEXT;
  RETURN;
END $$;

SELECT * FROM _diag_creditos_caducan();
DROP FUNCTION _diag_creditos_caducan();
