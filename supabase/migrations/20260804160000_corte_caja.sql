-- ── CORTE DE CAJA ────────────────────────────────────────────────────────────
-- Cierra un periodo de efectivo: compara el efectivo NETO que registró el sistema
-- (cobros en efectivo − reembolsos en efectivo desde el último corte) contra lo
-- que recepción cuenta físicamente, y guarda la diferencia (sobrante/faltante).
-- Tarjeta/transferencia/online NO cuentan (no tocan el cajón). Por sucursal.

CREATE TABLE IF NOT EXISTS cortes_caja (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sucursal_id uuid REFERENCES sucursales(id) ON DELETE SET NULL,
  realizado_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  desde timestamptz,                              -- inicio del periodo (hasta del corte anterior; null = desde el inicio)
  hasta timestamptz NOT NULL,                     -- momento del corte
  efectivo_esperado_centavos integer NOT NULL,    -- neto de efectivo del periodo (según el sistema)
  fondo_centavos integer NOT NULL DEFAULT 0,      -- fondo inicial del cajón
  efectivo_contado_centavos integer NOT NULL,     -- lo que contó recepción
  diferencia_centavos integer NOT NULL,           -- contado − (esperado + fondo): + sobra, − falta
  notas text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cortes_caja_tenant_idx ON cortes_caja (tenant_id, hasta DESC);
CREATE INDEX IF NOT EXISTS cortes_caja_scope_idx  ON cortes_caja (tenant_id, sucursal_id, hasta DESC);

ALTER TABLE cortes_caja ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cortes_caja_read_staff ON cortes_caja;
CREATE POLICY cortes_caja_read_staff ON cortes_caja
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista());
-- Sin policy de INSERT/UPDATE/DELETE: solo lo escribe la RPC (SECURITY DEFINER).

-- ── Preview: cuánto efectivo esperar en el próximo corte ────────────────────
CREATE OR REPLACE FUNCTION preview_corte_caja(p_sucursal_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid;
  v_desde timestamptz;
  v_esperado integer;
BEGIN
  IF NOT is_recepcionista() THEN RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin'; END IF;
  v_tenant := get_my_tenant_id();

  SELECT hasta INTO v_desde FROM cortes_caja
   WHERE tenant_id = v_tenant AND sucursal_id IS NOT DISTINCT FROM p_sucursal_id
   ORDER BY hasta DESC LIMIT 1;

  SELECT COALESCE(SUM(monto_centavos), 0) INTO v_esperado FROM pagos
   WHERE tenant_id = v_tenant AND metodo = 'efectivo'
     AND (p_sucursal_id IS NULL OR sucursal_id = p_sucursal_id)
     AND (v_desde IS NULL OR created_at >= v_desde);

  RETURN jsonb_build_object('desde', v_desde, 'efectivo_esperado_centavos', v_esperado);
END; $$;

-- ── Hacer el corte (atómico) ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION hacer_corte_caja(
  p_sucursal_id uuid DEFAULT NULL,
  p_efectivo_contado_centavos integer DEFAULT 0,
  p_fondo_centavos integer DEFAULT 0,
  p_notas text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid; v_actor uuid;
  v_desde timestamptz; v_hasta timestamptz := now();
  v_esperado integer; v_dif integer; v_id uuid;
BEGIN
  IF NOT is_recepcionista() THEN RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin'; END IF;
  v_tenant := get_my_tenant_id();
  v_actor  := get_my_user_id();

  IF p_efectivo_contado_centavos < 0 OR p_fondo_centavos < 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO: los montos no pueden ser negativos';
  END IF;
  IF p_sucursal_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM sucursales WHERE id = p_sucursal_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'SUCURSAL_INVALIDA';
  END IF;

  -- Serializa cortes concurrentes del MISMO scope (evita solapar periodos).
  PERFORM pg_advisory_xact_lock(hashtext('corte:' || v_tenant::text || ':' || COALESCE(p_sucursal_id::text, 'all')));

  SELECT hasta INTO v_desde FROM cortes_caja
   WHERE tenant_id = v_tenant AND sucursal_id IS NOT DISTINCT FROM p_sucursal_id
   ORDER BY hasta DESC LIMIT 1;

  SELECT COALESCE(SUM(monto_centavos), 0) INTO v_esperado FROM pagos
   WHERE tenant_id = v_tenant AND metodo = 'efectivo'
     AND (p_sucursal_id IS NULL OR sucursal_id = p_sucursal_id)
     AND (v_desde IS NULL OR created_at >= v_desde)
     AND created_at < v_hasta;

  v_dif := p_efectivo_contado_centavos - (v_esperado + p_fondo_centavos);

  INSERT INTO cortes_caja (
    tenant_id, sucursal_id, realizado_por, desde, hasta,
    efectivo_esperado_centavos, fondo_centavos, efectivo_contado_centavos, diferencia_centavos, notas
  ) VALUES (
    v_tenant, p_sucursal_id, v_actor, v_desde, v_hasta,
    v_esperado, p_fondo_centavos, p_efectivo_contado_centavos, v_dif, NULLIF(trim(p_notas), '')
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true, 'id', v_id, 'desde', v_desde, 'hasta', v_hasta,
    'efectivo_esperado_centavos', v_esperado, 'fondo_centavos', p_fondo_centavos,
    'efectivo_contado_centavos', p_efectivo_contado_centavos, 'diferencia_centavos', v_dif
  );
END; $$;

REVOKE ALL ON FUNCTION preview_corte_caja(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION hacer_corte_caja(uuid, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION preview_corte_caja(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION hacer_corte_caja(uuid, integer, integer, text) TO authenticated;

-- ── Self-test (devuelve TABLA) ──────────────────────────────────────────────
SELECT 'tabla cortes_caja existe' AS prueba,
       EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'cortes_caja') AS pasa
UNION ALL
SELECT 'cortes_caja con RLS',
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE relname = 'cortes_caja'), false)
UNION ALL
SELECT 'RPC hacer_corte_caja existe',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'hacer_corte_caja')
UNION ALL
SELECT 'RPC preview_corte_caja existe',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'preview_corte_caja')
UNION ALL
SELECT 'authenticated ejecuta hacer_corte_caja',
       has_function_privilege('authenticated', 'hacer_corte_caja(uuid, integer, integer, text)', 'EXECUTE')
UNION ALL
SELECT 'anon NO ejecuta hacer_corte_caja',
       NOT has_function_privilege('anon', 'hacer_corte_caja(uuid, integer, integer, text)', 'EXECUTE');