-- ============================================================================
-- TIERS: validaciones que faltaban (moneda y duración)
-- ----------------------------------------------------------------------------
-- La tabla `tiers` ya tiene CHECKs en periodo, tipo, precio (>=0), inscripción,
-- invitados. Pero dos columnas aceptaban cualquier cosa:
--   · `moneda`  → cualquier string ('', 'XYZ'). El resto del sistema asume
--     MXN/USD/EUR; una moneda inválida rompe el formateo y los reportes.
--   · `duracion_dias` → aceptaba 0 o negativos. NULL es válido a propósito
--     (plan sin vencimiento), pero un plan que "dura 0 días" no tiene sentido.
--
-- Se agregan como NOT VALID: enforza las escrituras NUEVAS ya mismo, sin correr
-- el riesgo de que la migración aborte por una fila vieja rara. La moneda de las
-- filas existentes se normaliza a mayúsculas antes (MXN, no mxn), que es como la
-- usa el resto del código (el default de la columna es 'MXN').
-- ============================================================================

-- Normalizar la moneda existente (mxn → MXN) para que la vista y los reportes la
-- lean consistente. Solo toca filas que difieran.
UPDATE tiers SET moneda = upper(moneda) WHERE moneda IS NOT NULL AND moneda <> upper(moneda);

ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_moneda_valida;
ALTER TABLE tiers ADD CONSTRAINT tiers_moneda_valida
  CHECK (moneda IN ('MXN', 'USD', 'EUR')) NOT VALID;

ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_duracion_positiva;
ALTER TABLE tiers ADD CONSTRAINT tiers_duracion_positiva
  CHECK (duracion_dias IS NULL OR duracion_dias > 0) NOT VALID;


-- ============================================================================
-- SELF-TEST: las escrituras nuevas rechazan moneda inválida y duración <= 0.
-- ============================================================================
DO $$
DECLARE
  v_tenant uuid;
  v_slug text := 'zz-test-tiers-checks-' || substr(md5(random()::text), 1, 6);
  v_err text;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test tiers checks', 'gym_libre', 'activo')
  RETURNING id INTO v_tenant;

  -- 1) Moneda inválida → rechazada.
  BEGIN
    INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, activo, orden)
    VALUES (v_tenant, 'malo-moneda', 'Malo', 'tiempo', 10000, 'XYZ', true, 0);
    RAISE EXCEPTION 'FALLA: aceptó una moneda inválida';
  EXCEPTION WHEN check_violation THEN
    NULL; -- esperado
  END;

  -- 2) Duración 0 → rechazada.
  BEGIN
    INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, activo, orden)
    VALUES (v_tenant, 'malo-dur', 'Malo', 'tiempo', 10000, 'MXN', 0, true, 0);
    RAISE EXCEPTION 'FALLA: aceptó duración de 0 días';
  EXCEPTION WHEN check_violation THEN
    NULL; -- esperado
  END;

  -- 3) Un tier válido (moneda ok + duración positiva) sí entra.
  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, activo, orden)
  VALUES (v_tenant, 'bueno', 'Bueno', 'tiempo', 10000, 'MXN', 30, true, 0);

  -- 4) Duración NULL (plan sin vencimiento) también es válida. Usamos un plan
  --    'tiempo' porque los de 'creditos' tienen su propia regla (clases > 0),
  --    ajena a lo que probamos acá.
  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, activo, orden)
  VALUES (v_tenant, 'sin-venc', 'Sin vencimiento', 'tiempo', 10000, 'MXN', NULL, true, 1);

  DELETE FROM tiers WHERE tenant_id = v_tenant;
  DELETE FROM tenants WHERE id = v_tenant;
END;
$$;

SELECT 'moneda inválida se rechaza' AS prueba, 'rechazado' AS espera, 'OK' AS resultado
UNION ALL SELECT 'duración de 0 días se rechaza', 'rechazado', 'OK'
UNION ALL SELECT 'un tier válido entra', 'aceptado', 'OK'
UNION ALL SELECT 'duración NULL (sin vencimiento) entra', 'aceptado', 'OK';
