-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- DEVOLVER "FUE CORTESÍA" — reembolsa el cobro Y lo cuenta como cortesía
-- ────────────────────────────────────────────────────────────────────────────
-- Caso: cobraste un plan y luego resulta que era cortesía (comp). Antes, "Devolver"
-- solo hacía un reembolso con el método original (efectivo) → el dinero cuadraba en
-- 0, PERO no entraba al total de "cortesías en dinero" de la Caja.
--
-- Este RPC hace las DOS cosas atómicamente:
--   1) registrar_reembolso: revierte el cobro real (−$X, método original) → el
--      ingreso neto queda en 0. Reusa toda su validación (tope, motivo, etc.).
--   2) asienta una cortesía (+$X, metodo='cortesia', mismo concepto) → suma en
--      "cortesías en dinero". Como el método 'cortesia' se excluye de 'cobrado',
--      ese +$X NO infla los ingresos; solo cuenta como comp.
--
-- Resultado idéntico a si desde el inicio hubiera sido cortesía.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION reembolsar_como_cortesia(
  p_pago_id uuid,
  p_monto_centavos integer DEFAULT NULL,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pago pagos;
  v_res jsonb;
  v_monto integer;
  v_cortesia_id uuid;
  v_actor uuid := get_my_user_id();
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden hacer esto';
  END IF;

  SELECT * INTO v_pago FROM pagos WHERE id = p_pago_id;
  IF v_pago.id IS NULL THEN
    RAISE EXCEPTION 'PAGO_NO_EXISTE: no encontramos ese cobro';
  END IF;
  IF v_pago.tenant_id <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese cobro no es de tu gimnasio';
  END IF;

  -- 1) Reembolso del cobro real (revierte el ingreso). Reusa TODA la validación de
  --    registrar_reembolso: montos, tope, motivo, no-cortesía, no-doble reembolso.
  v_res := registrar_reembolso(p_pago_id, p_monto_centavos, COALESCE(NULLIF(trim(p_motivo), ''), 'Fue cortesía'));
  v_monto := (v_res->>'monto_centavos')::integer;

  -- 2) Asentar la cortesía por ese mismo monto → suma en "cortesías en dinero".
  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id,
    concepto, monto_centavos, moneda, metodo, notas, cobrado_por
  ) VALUES (
    v_pago.tenant_id, v_pago.sucursal_id, v_pago.usuario_id,
    v_pago.concepto, v_monto, COALESCE(v_pago.moneda, 'MXN'), 'cortesia',
    'Cortesía (cobro revertido): ' || COALESCE(NULLIF(trim(p_motivo), ''), 'era cortesía'),
    v_actor
  )
  RETURNING id INTO v_cortesia_id;

  RETURN jsonb_build_object(
    'success', true,
    'reembolso_id', v_res->>'reembolso_id',
    'cortesia_id', v_cortesia_id,
    'monto_centavos', v_monto
  );
END;
$$;

REVOKE ALL ON FUNCTION reembolsar_como_cortesia(uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reembolsar_como_cortesia(uuid, integer, text) FROM anon;
GRANT EXECUTE ON FUNCTION reembolsar_como_cortesia(uuid, integer, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- SELF-TEST funcional (con dinero de verdad): tenant desechable + admin simulado.
-- Verifica: reembolso −$X, cortesía +$X, ingreso neto (sin cortesía) = 0. Limpia.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tenant uuid; v_admin uuid; v_socio uuid; v_pago uuid;
  v_auth uuid := gen_random_uuid();
  v_slug text := 'zz-test-cort-' || substr(md5(random()::text), 1, 6);
  v_res jsonb; v_reemb int; v_cortesias int; v_neto int;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test cortesía', 'gym_libre', 'activo')
  RETURNING id INTO v_tenant;

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, raw_user_meta_data,
    encrypted_password, email_confirmed_at, created_at, updated_at
  ) VALUES (
    v_auth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    v_slug || '-admin@sala.dev',
    jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'),
    '', now(), now(), now()
  );
  UPDATE usuarios SET rol = 'admin', status = 'activo' WHERE auth_id = v_auth RETURNING id INTO v_admin;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'FALLA: el signup no creó al admin de prueba'; END IF;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug || '-socio@sala.dev', 'Socio', 'miembro', 'activo')
  RETURNING id INTO v_socio;

  -- Cobro real de $1.000 en efectivo.
  INSERT INTO pagos (tenant_id, usuario_id, concepto, metodo, monto_centavos, moneda)
  VALUES (v_tenant, v_socio, 'plan', 'efectivo', 100000, 'MXN')
  RETURNING id INTO v_pago;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- Devolver TODO como cortesía.
  v_res := reembolsar_como_cortesia(v_pago, 100000, 'Se le dio de cortesía');

  SELECT COALESCE(SUM(monto_centavos), 0) INTO v_reemb
  FROM pagos WHERE tenant_id = v_tenant AND concepto = 'reembolso';
  IF v_reemb <> -100000 THEN RAISE EXCEPTION 'FALLA: reembolso esperado -100000, fue %', v_reemb; END IF;

  SELECT COALESCE(SUM(monto_centavos), 0) INTO v_cortesias
  FROM pagos WHERE tenant_id = v_tenant AND metodo = 'cortesia';
  IF v_cortesias <> 100000 THEN RAISE EXCEPTION 'FALLA: cortesías esperado 100000, fue %', v_cortesias; END IF;

  SELECT COALESCE(SUM(monto_centavos), 0) INTO v_neto
  FROM pagos WHERE tenant_id = v_tenant AND metodo <> 'cortesia';
  IF v_neto <> 0 THEN RAISE EXCEPTION 'FALLA: ingreso neto (sin cortesía) esperaba 0, fue %', v_neto; END IF;

  -- El cobro original sigue intacto (append-only).
  IF NOT EXISTS (SELECT 1 FROM pagos WHERE id = v_pago AND monto_centavos = 100000) THEN
    RAISE EXCEPTION 'FALLA: se tocó el cobro original (el ledger es append-only)';
  END IF;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
END;
$$;

SELECT
  'devolver como cortesía' AS prueba,
  'reembolso -X + cortesía +X, ingreso neto 0' AS espera,
  'OK' AS resultado
UNION ALL
SELECT 'anon no puede ejecutarlo', 'sin EXECUTE para anon',
  CASE WHEN has_function_privilege('anon', 'reembolsar_como_cortesia(uuid, integer, text)', 'EXECUTE')
       THEN 'FALLA' ELSE 'OK' END;