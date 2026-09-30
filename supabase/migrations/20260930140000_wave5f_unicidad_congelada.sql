-- ============================================================================
-- WAVE 5 · F — Unicidad de membresía viva: incluir 'congelada'
-- ----------------------------------------------------------------------------
-- RC-05-E: el índice único parcial membresias_one_active_per_user cubre solo
-- status IN ('trialing','activa','past_due') → 'congelada' quedaba fuera, así
-- que en teoría un socio podía tener una 'activa' y una 'congelada' a la vez
-- (reachable solo por INSERT directo; el flujo normal hace UPDATE de la misma
-- fila). Se extiende el índice a incluir 'congelada' para cerrarlo a nivel
-- estructural. Verificado read-only: 0 conflictos hoy.
--
-- BEGIN/COMMIT con pre-check (aborta si hubiera conflicto) + self-test.
-- No toca datos reales; no cambia RPCs. cancelada/expirada siguen fuera (son
-- históricas, múltiples por socio es correcto).
-- ============================================================================

BEGIN;

-- Pre-check: si por cualquier motivo hubiera un socio con >1 membresía en el
-- set extendido, abortar (no forzar el índice sobre datos en conflicto).
DO $$
DECLARE v_c integer;
BEGIN
  SELECT count(*) INTO v_c FROM (
    SELECT usuario_id FROM membresias
    WHERE status IN ('trialing','activa','past_due','congelada')
    GROUP BY usuario_id HAVING count(*) > 1
  ) x;
  IF v_c > 0 THEN
    RAISE EXCEPTION 'W5-F ABORT: % socio(s) con >1 membresía viva (activa/trialing/past_due/congelada) — resolver antes de extender el índice', v_c;
  END IF;
END $$;

-- Swap del índice único parcial (mismo nombre) para incluir 'congelada'.
DROP INDEX IF EXISTS membresias_one_active_per_user;
CREATE UNIQUE INDEX membresias_one_active_per_user
  ON membresias (usuario_id)
  WHERE status IN ('trialing','activa','past_due','congelada');

COMMENT ON INDEX membresias_one_active_per_user IS
  'W5-F. Una sola membresía VIVA por socio (trialing/activa/past_due/congelada). '
  'cancelada/expirada quedan fuera (históricas, múltiples permitidas).';

-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — tenant desechable; cerrar_tenant limpia.
-- ============================================================================
CREATE TEMP TABLE _w5f_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $$
DECLARE
  v_slug text := 'zz-w5f-' || substr(md5(random()::text), 1, 6);
  v_tenant uuid; v_u uuid; v_tier uuid;
  v_ok boolean;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug,'W5F','gym_libre','activo') RETURNING id INTO v_tenant;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-u@sala.dev','U','miembro','activo') RETURNING id INTO v_u;
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, duracion_dias) VALUES (v_tenant,'w5f-t','Tiempo',100000,'tiempo',30) RETURNING id INTO v_tier;

  -- Una membresía activa.
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
  VALUES (v_tenant, v_u, v_tier, 'activa', now(), now()+interval '30 days');

  -- Intentar una CONGELADA para el mismo socio → debe violar el índice extendido.
  v_ok := false;
  BEGIN
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, congelada_at)
    VALUES (v_tenant, v_u, v_tier, 'congelada', now(), now()+interval '30 days', now());
  EXCEPTION WHEN unique_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'W5-F T1 FALLO: se permitió activa + congelada simultáneas'; END IF;
  INSERT INTO _w5f_res VALUES (1, 'activa + congelada simultáneas BLOQUEADO (índice extendido)', 'OK');

  -- Una segunda ACTIVA también debe bloquear (cobertura previa preservada).
  v_ok := false;
  BEGIN
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
    VALUES (v_tenant, v_u, v_tier, 'activa', now(), now()+interval '30 days');
  EXCEPTION WHEN unique_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'W5-F T2 FALLO: se permitió una segunda activa'; END IF;
  INSERT INTO _w5f_res VALUES (2, 'segunda activa BLOQUEADA (cobertura previa intacta)', 'OK');

  -- Una expirada/cancelada SÍ puede coexistir (históricas).
  v_ok := true;
  BEGIN
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
    VALUES (v_tenant, v_u, v_tier, 'expirada', now()-interval '60 days', now()-interval '30 days');
  EXCEPTION WHEN OTHERS THEN v_ok := false;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'W5-F T3 FALLO: no se permitió una expirada histórica junto a la activa'; END IF;
  INSERT INTO _w5f_res VALUES (3, 'expirada histórica SÍ coexiste con la activa', 'OK');

  PERFORM cerrar_tenant(v_slug);
END $$;

SELECT orden, prueba, resultado FROM _w5f_res ORDER BY orden;

COMMIT;
