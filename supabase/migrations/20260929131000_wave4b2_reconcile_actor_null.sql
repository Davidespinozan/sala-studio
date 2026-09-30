-- ============================================================================
-- WAVE 4-B (pieza 2) — Reconcile de tier: asiento SIEMPRE (fix actor NULL)
-- ----------------------------------------------------------------------------
-- Hueco (W4 forense): reconciliar_creditos_por_cambio_tier otorgaba créditos a
-- los socios en NULL cuando un plan pasa a créditos/híbrido, PERO solo dejaba
-- asiento en el ledger si había actor (get_my_user_id() NOT NULL). Editar el tier
-- por service_role/SQL (actor NULL) mutaba el saldo OFF-LEDGER → divergencia.
--
-- Fix: enrutar cada membresía afectada por _aplicar_credito (W4-A) → el asiento
-- se escribe SIEMPRE (created_by NULL es válido para acciones de sistema). Mismo
-- criterio de a quién toca (solo creditos_restantes IS NULL → idempotente por
-- socio) y mismo monto (clases_incluidas). Aditiva; BEGIN/COMMIT + self-test.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION reconciliar_creditos_por_cambio_tier()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();  -- NULL si el UPDATE viene de service_role/SQL
  v_m RECORD;
BEGIN
  -- Solo planes que (ahora) son de créditos/híbrido con paquete definido.
  IF NEW.tipo NOT IN ('creditos','hibrido') THEN RETURN NEW; END IF;
  IF COALESCE(NEW.clases_incluidas, 0) <= 0 THEN RETURN NEW; END IF;
  -- Solo si cambió el tipo o el tamaño del paquete (no en cada edición del plan).
  IF OLD.tipo IS NOT DISTINCT FROM NEW.tipo
     AND OLD.clases_incluidas IS NOT DISTINCT FROM NEW.clases_incluidas THEN
    RETURN NEW;
  END IF;

  -- W4-B: otorgar por la puerta canónica → saldo + asiento SIEMPRE (aun con
  -- actor NULL). Solo toca filas en NULL (idempotente por socio). El saldo pasa
  -- de NULL(=0) a clases_incluidas; el asiento 'alta' registra el otorgamiento.
  FOR v_m IN
    SELECT m.id
    FROM membresias m
    WHERE m.tier_id = NEW.id
      AND m.status IN ('trialing','activa','past_due','congelada')
      AND m.creditos_restantes IS NULL
  LOOP
    PERFORM _aplicar_credito(
      v_m.id, NEW.clases_incluidas, 'alta',
      format('créditos otorgados por reconfiguración del plan a %s clase(s) (tier %s)',
             NEW.clases_incluidas, NEW.slug),
      NULL, NULL, v_actor
    );
  END LOOP;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS tiers_reconciliar_creditos ON tiers;
CREATE TRIGGER tiers_reconciliar_creditos
  AFTER UPDATE ON tiers
  FOR EACH ROW EXECUTE FUNCTION reconciliar_creditos_por_cambio_tier();


-- ============================================================================
-- SELF-TEST (DEVUELVE TABLA) — tenant desechable; cerrar_tenant limpia al final.
--   NULL → 40 + asiento 'alta' +40 (aun con actor NULL = el hueco cerrado);
--   saldo 5 no se toca; saldo 0 no se re-regala.
-- ============================================================================
CREATE TEMP TABLE _w4b2_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $$
DECLARE
  v_slug text := 'zz-w4b2-' || substr(md5(random()::text), 1, 6);
  v_tenant uuid; v_tier uuid;
  v_s_null uuid; v_s_saldo uuid; v_s_cero uuid;
  v_m_null uuid; v_m_saldo uuid; v_m_cero uuid;
  v_null int; v_saldo int; v_cero int;
  v_asientos int;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'W4B2', 'gym_libre', 'activo') RETURNING id INTO v_tenant;

  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, activo, orden)
  VALUES (v_tenant, 'reconc-test', 'Reconc Test', 'tiempo', 100000, 'MXN', 30, true, 999)
  RETURNING id INTO v_tier;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug||'-null@sala.dev', 'Null', 'miembro', 'activo') RETURNING id INTO v_s_null;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug||'-saldo@sala.dev', 'Saldo', 'miembro', 'activo') RETURNING id INTO v_s_saldo;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug||'-cero@sala.dev', 'Cero', 'miembro', 'activo') RETURNING id INTO v_s_cero;

  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
  VALUES (v_tenant, v_s_null, v_tier, 'activa', now(), now()+interval '30 days', NULL) RETURNING id INTO v_m_null;
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
  VALUES (v_tenant, v_s_saldo, v_tier, 'activa', now(), now()+interval '30 days', 5) RETURNING id INTO v_m_saldo;
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
  VALUES (v_tenant, v_s_cero, v_tier, 'activa', now(), now()+interval '30 days', 0) RETURNING id INTO v_m_cero;

  -- Disparo: el plan pasa a créditos(40). En la migración get_my_user_id() es NULL.
  UPDATE tiers SET tipo='creditos', clases_incluidas=40 WHERE id = v_tier;

  SELECT creditos_restantes INTO v_null  FROM membresias WHERE id = v_m_null;
  SELECT creditos_restantes INTO v_saldo FROM membresias WHERE id = v_m_saldo;
  SELECT creditos_restantes INTO v_cero  FROM membresias WHERE id = v_m_cero;

  IF v_null IS DISTINCT FROM 40 THEN RAISE EXCEPTION 'FALLO: NULL no quedó en 40 (=%).', v_null; END IF;
  IF v_saldo IS DISTINCT FROM 5 THEN RAISE EXCEPTION 'FALLO: se pisó el saldo de 5 (=%).', v_saldo; END IF;
  IF v_cero  IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FALLO: se re-regaló al de 0 (=%).', v_cero; END IF;

  -- El fix: aun con actor NULL, DEBE quedar asiento del otorgamiento.
  SELECT count(*) INTO v_asientos
  FROM membresia_movimientos
  WHERE membresia_id = v_m_null AND tipo='alta' AND delta_creditos=40;
  IF v_asientos <> 1 THEN
    RAISE EXCEPTION 'FALLO: el otorgamiento a la membresía NULL no dejó asiento (actor NULL) — asientos=%', v_asientos;
  END IF;

  INSERT INTO _w4b2_res VALUES (1, 'reconcile: NULL→40 y saldo 5/0 respetados', 'OK');
  INSERT INTO _w4b2_res VALUES (2, 'reconcile con actor NULL SÍ deja asiento (hueco cerrado)', 'OK');

  PERFORM cerrar_tenant(v_slug);
END $$;

SELECT orden, prueba, resultado FROM _w4b2_res ORDER BY orden;

COMMIT;
