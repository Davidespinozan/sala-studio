-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- EL CORTE GUARDA SU RESUMEN AL NACER (+ backfill de los existentes).
-- ────────────────────────────────────────────────────────────────────────────
-- `cortes_caja.resumen` (snapshot: total, por concepto, por método) solo lo
-- llenaba la importación de cortes históricos; los cortes hechos desde la app
-- quedaban con resumen NULL. Se notó con el corte simple de numa: la lista
-- muestra el total del snapshot, y los cortes propios salían sin cifra.
--
-- Ahora hacer_corte_caja calcula y guarda el resumen al crear (mismo desglose
-- y etiquetas que la UI: cortesías fuera, reembolsos restan), y un backfill
-- rellena los cortes viejos. El ticket ya usaba resumen-si-existe → sin cambios.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Helper: resumen de un periodo (misma lógica que desgloseDePeriodo en UI) ──
CREATE OR REPLACE FUNCTION _resumen_corte(
  p_tenant uuid, p_sucursal uuid, p_desde timestamptz, p_hasta timestamptz
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filas AS (
    SELECT
      CASE WHEN concepto IN ('plan', 'inscripcion') THEN 'Membresías'
           WHEN concepto = 'paquete'   THEN 'Paquetes'
           WHEN concepto = 'producto'  THEN 'Productos'
           WHEN concepto = 'reembolso' THEN 'Devoluciones'
           ELSE 'Otros' END AS concepto_label,
      CASE metodo WHEN 'efectivo' THEN 'Efectivo' WHEN 'tarjeta' THEN 'Tarjeta'
                  WHEN 'transferencia' THEN 'Transferencia' WHEN 'stripe' THEN 'Online'
                  ELSE metodo END AS metodo_label,
      monto_centavos
    FROM pagos
    WHERE tenant_id = p_tenant
      AND metodo <> 'cortesia'                -- cortesía no es dinero que entró
      AND (p_sucursal IS NULL OR sucursal_id = p_sucursal)
      AND (p_desde IS NULL OR created_at >= p_desde)
      AND created_at < p_hasta
  ),
  conc AS (SELECT concepto_label AS label, SUM(monto_centavos) AS centavos FROM filas GROUP BY 1),
  met  AS (SELECT metodo_label   AS label, SUM(monto_centavos) AS centavos FROM filas GROUP BY 1)
  SELECT jsonb_build_object(
    'total_centavos', COALESCE((SELECT SUM(monto_centavos) FROM filas), 0),
    'por_concepto', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('label', label, 'centavos', centavos)
             ORDER BY array_position(ARRAY['Membresías','Paquetes','Productos','Otros','Devoluciones'], label))
      FROM conc), '[]'::jsonb),
    'por_metodo', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('label', label, 'centavos', centavos) ORDER BY label)
      FROM met), '[]'::jsonb)
  );
$$;

-- Recibe tenant por parámetro → NADIE del cliente la llama directo.
REVOKE ALL ON FUNCTION _resumen_corte(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- ── hacer_corte_caja v3: igual que antes + guarda el resumen ────────────────
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
  v_esperado integer; v_dif integer; v_id uuid; v_resumen jsonb;
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
  v_resumen := _resumen_corte(v_tenant, p_sucursal_id, p_desde, p_hasta);

  INSERT INTO cortes_caja (
    tenant_id, sucursal_id, realizado_por, desde, hasta,
    efectivo_esperado_centavos, fondo_centavos, efectivo_contado_centavos, diferencia_centavos, notas, resumen
  ) VALUES (
    v_tenant, p_sucursal_id, v_actor, p_desde, p_hasta,
    v_esperado, p_fondo_centavos, p_efectivo_contado_centavos, v_dif, NULLIF(trim(p_notas), ''), v_resumen
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true, 'id', v_id, 'desde', p_desde, 'hasta', p_hasta,
    'efectivo_esperado_centavos', v_esperado, 'fondo_centavos', p_fondo_centavos,
    'efectivo_contado_centavos', p_efectivo_contado_centavos, 'diferencia_centavos', v_dif,
    'resumen', v_resumen
  );
END; $$;

REVOKE ALL ON FUNCTION hacer_corte_caja(timestamptz, timestamptz, uuid, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION hacer_corte_caja(timestamptz, timestamptz, uuid, integer, integer, text) TO authenticated;

-- ── Backfill: cortes existentes sin snapshot ────────────────────────────────
UPDATE cortes_caja c
SET resumen = _resumen_corte(c.tenant_id, c.sucursal_id, c.desde, c.hasta)
WHERE c.resumen IS NULL;

-- ── SELF-TEST (tabla): el resumen cuadra con pagos sintéticos ───────────────
DO $$
DECLARE
  v_tenant uuid; v_socio uuid; v_res jsonb; v_pago_plan uuid;
  v_slug text := 'zz-test-resumen-' || substr(md5(random()::text), 1, 6);
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test resumen corte', 'gym_libre', 'activo') RETURNING id INTO v_tenant;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug || '@sala.dev', 'Socio', 'miembro', 'activo') RETURNING id INTO v_socio;

  INSERT INTO pagos (tenant_id, usuario_id, concepto, monto_centavos, moneda, metodo)
  VALUES (v_tenant, v_socio, 'plan', 100000, 'MXN', 'efectivo') RETURNING id INTO v_pago_plan;
  INSERT INTO pagos (tenant_id, usuario_id, concepto, monto_centavos, moneda, metodo)
  VALUES (v_tenant, v_socio, 'producto', 5000, 'MXN', 'tarjeta'),
         (v_tenant, v_socio, 'paquete', 15000, 'MXN', 'cortesia');          -- fuera del total
  -- El CHECK pagos_asiento_coherente exige que el reembolso apunte a su cobro.
  INSERT INTO pagos (tenant_id, usuario_id, concepto, monto_centavos, moneda, metodo, revierte_pago_id)
  VALUES (v_tenant, v_socio, 'reembolso', -2000, 'MXN', 'efectivo', v_pago_plan); -- resta

  v_res := _resumen_corte(v_tenant, NULL, now() - interval '1 hour', now() + interval '1 hour');
  IF (v_res->>'total_centavos')::int <> 103000 THEN
    RAISE EXCEPTION 'TEST FALLO: total esperaba 103000, fue %', v_res->>'total_centavos';
  END IF;

  RAISE EXCEPTION 'ROLLBACK_OK_RESUMEN';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'TEST FALLO%' THEN RAISE;
  ELSIF SQLERRM = 'ROLLBACK_OK_RESUMEN' THEN NULL;
  ELSE RAISE;
  END IF;
END $$;

SELECT
  'corte guarda resumen al crear + backfill'                               AS prueba,
  (SELECT pg_get_functiondef(oid) LIKE '%_resumen_corte%'
     FROM pg_proc WHERE proname = 'hacer_corte_caja')                      AS rpc_usa_resumen,
  (SELECT count(*) FROM cortes_caja WHERE resumen IS NULL)                 AS cortes_sin_resumen_debe_ser_0,
  NOT has_function_privilege('authenticated', '_resumen_corte(uuid, uuid, timestamptz, timestamptz)', 'EXECUTE') AS helper_bloqueado;