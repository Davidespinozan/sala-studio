-- ── Corte de caja POR RANGO de fechas (elegido por el staff) ────────────────
-- Antes el corte iba "desde el último corte hasta ahora". Ahora el admin elige el
-- rango (de cuándo a cuándo). El front manda desde/hasta en el horario del gym
-- (fronteras del día locales del dispositivo). Reemplazamos las 2 RPCs.

DROP FUNCTION IF EXISTS preview_corte_caja(uuid);
DROP FUNCTION IF EXISTS hacer_corte_caja(uuid, integer, integer, text);

-- Preview: efectivo neto esperado en el rango.
CREATE OR REPLACE FUNCTION preview_corte_caja(
  p_desde timestamptz,
  p_hasta timestamptz,
  p_sucursal_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid;
  v_esperado integer;
BEGIN
  IF NOT is_recepcionista() THEN RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin'; END IF;
  v_tenant := get_my_tenant_id();

  SELECT COALESCE(SUM(monto_centavos), 0) INTO v_esperado FROM pagos
   WHERE tenant_id = v_tenant AND metodo = 'efectivo'
     AND (p_sucursal_id IS NULL OR sucursal_id = p_sucursal_id)
     AND created_at >= p_desde AND created_at < p_hasta;

  RETURN jsonb_build_object('efectivo_esperado_centavos', v_esperado);
END; $$;

-- Hacer el corte del rango dado.
CREATE OR REPLACE FUNCTION hacer_corte_caja(
  p_desde timestamptz,
  p_hasta timestamptz,
  p_sucursal_id uuid DEFAULT NULL,
  p_efectivo_contado_centavos integer DEFAULT 0,
  p_fondo_centavos integer DEFAULT 0,
  p_notas text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid; v_actor uuid;
  v_esperado integer; v_dif integer; v_id uuid;
BEGIN
  IF NOT is_recepcionista() THEN RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin'; END IF;
  v_tenant := get_my_tenant_id();
  v_actor  := get_my_user_id();

  IF p_efectivo_contado_centavos < 0 OR p_fondo_centavos < 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO: los montos no pueden ser negativos';
  END IF;
  IF p_hasta <= p_desde THEN
    RAISE EXCEPTION 'RANGO_INVALIDO: la fecha final debe ser mayor que la inicial';
  END IF;
  IF p_sucursal_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM sucursales WHERE id = p_sucursal_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'SUCURSAL_INVALIDA';
  END IF;

  SELECT COALESCE(SUM(monto_centavos), 0) INTO v_esperado FROM pagos
   WHERE tenant_id = v_tenant AND metodo = 'efectivo'
     AND (p_sucursal_id IS NULL OR sucursal_id = p_sucursal_id)
     AND created_at >= p_desde AND created_at < p_hasta;

  v_dif := p_efectivo_contado_centavos - (v_esperado + p_fondo_centavos);

  INSERT INTO cortes_caja (
    tenant_id, sucursal_id, realizado_por, desde, hasta,
    efectivo_esperado_centavos, fondo_centavos, efectivo_contado_centavos, diferencia_centavos, notas
  ) VALUES (
    v_tenant, p_sucursal_id, v_actor, p_desde, p_hasta,
    v_esperado, p_fondo_centavos, p_efectivo_contado_centavos, v_dif, NULLIF(trim(p_notas), '')
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true, 'id', v_id, 'desde', p_desde, 'hasta', p_hasta,
    'efectivo_esperado_centavos', v_esperado, 'fondo_centavos', p_fondo_centavos,
    'efectivo_contado_centavos', p_efectivo_contado_centavos, 'diferencia_centavos', v_dif
  );
END; $$;

REVOKE ALL ON FUNCTION preview_corte_caja(timestamptz, timestamptz, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION hacer_corte_caja(timestamptz, timestamptz, uuid, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION preview_corte_caja(timestamptz, timestamptz, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION hacer_corte_caja(timestamptz, timestamptz, uuid, integer, integer, text) TO authenticated;

-- ── Self-test (tabla) ───────────────────────────────────────────────────────
SELECT 'hacer_corte_caja por rango existe' AS prueba,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'hacer_corte_caja'
               AND pg_get_function_identity_arguments(oid) LIKE 'p_desde timestamp%') AS pasa
UNION ALL
SELECT 'RPC vieja (uuid,integer,...) eliminada',
       NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'hacer_corte_caja'
                   AND pg_get_function_identity_arguments(oid) LIKE 'p_sucursal_id uuid,%')
UNION ALL
SELECT 'authenticated ejecuta la nueva',
       has_function_privilege('authenticated', 'hacer_corte_caja(timestamptz, timestamptz, uuid, integer, integer, text)', 'EXECUTE');