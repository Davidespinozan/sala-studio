-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- CUENTAS POR COBRAR — "pendiente / pagar al llegar"
-- ────────────────────────────────────────────────────────────────────────────
-- numa vende day passes (y otras cosas) que se pagan el día que la persona asiste,
-- no al momento. Hoy no había forma de dejarlo "pendiente": o cobras ya, o cortesía
-- (gratis). Ponerlo cortesía miente — infla las cortesías y esconde lo que te deben.
--
-- Esto agrega un registro de "por cobrar": monto adeudado, SIN contar como ingreso
-- ni como cortesía. Cuando la persona llega y paga, recepción lo cobra → ahí sí
-- entra a la Caja como ingreso real (efectivo/tarjeta).
--
-- Tabla aparte (no se ensucia el ledger append-only de `pagos`): `pagos` = dinero
-- que SÍ se movió; `cargos_pendientes` = dinero que se DEBE. Al cobrar, nace el pago.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cargos_pendientes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sucursal_id uuid REFERENCES sucursales(id) ON DELETE SET NULL,
  -- CASCADE (no RESTRICT): así el purge de tenant / borrado de socio no se traba
  -- por un cargo. Borrar un socio con transacciones reales ya lo frena admin-delete.
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  concepto text NOT NULL DEFAULT 'plan' CHECK (concepto IN ('plan','inscripcion','paquete','producto','otro')),
  descripcion text,                                   -- ej. "Day Pass jueves"
  monto_centavos integer NOT NULL CHECK (monto_centavos > 0),
  moneda text NOT NULL DEFAULT 'MXN',
  estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','cobrado','cancelado')),
  pago_id uuid REFERENCES pagos(id) ON DELETE SET NULL, -- el pago real, al cobrar
  motivo_cancelacion text,
  created_by uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cobrado_at timestamptz
);

CREATE INDEX IF NOT EXISTS cargos_pendientes_tenant_estado_idx
  ON cargos_pendientes (tenant_id, estado);
CREATE INDEX IF NOT EXISTS cargos_pendientes_usuario_idx
  ON cargos_pendientes (usuario_id);

COMMENT ON TABLE cargos_pendientes IS
  'Cuentas por cobrar: montos adeudados (day pass, etc.) que se cobran cuando el socio llega. No son ingreso hasta que se cobran (ahí nace el pago en `pagos`).';

-- Solo staff del tenant LEE (para la Caja "Por cobrar"). Las escrituras van por las
-- RPCs SECURITY DEFINER de abajo (no hay policy de INSERT/UPDATE para authenticated).
ALTER TABLE cargos_pendientes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cargos_pendientes_select ON cargos_pendientes;
CREATE POLICY cargos_pendientes_select ON cargos_pendientes
  FOR SELECT USING (tenant_id = get_my_tenant_id() AND is_recepcionista());

-- ── Registrar un cargo pendiente ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION registrar_cargo_pendiente(
  p_usuario_id uuid,
  p_monto_centavos integer,
  p_concepto text DEFAULT 'plan',
  p_descripcion text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_socio usuarios;
  v_id uuid;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden registrar un cargo';
  END IF;
  IF p_monto_centavos IS NULL OR p_monto_centavos <= 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO: El monto por cobrar debe ser mayor a 0';
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL OR v_socio.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'SOCIO_NO_EXISTE: Ese socio no es de este gimnasio';
  END IF;

  INSERT INTO cargos_pendientes (
    tenant_id, sucursal_id, usuario_id, concepto, descripcion, monto_centavos, moneda, created_by
  ) VALUES (
    v_tenant, v_socio.sucursal_id, p_usuario_id,
    COALESCE(NULLIF(p_concepto, ''), 'plan'), p_descripcion, p_monto_centavos, 'MXN', get_my_user_id()
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'cargo_id', v_id, 'monto_centavos', p_monto_centavos);
END;
$$;

-- ── Cobrar un cargo pendiente (nace el pago real) ───────────────────────────
CREATE OR REPLACE FUNCTION cobrar_cargo_pendiente(
  p_cargo_id uuid,
  p_metodo text DEFAULT 'efectivo'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cargo cargos_pendientes;
  v_pago_id uuid;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden cobrar';
  END IF;

  SELECT * INTO v_cargo FROM cargos_pendientes WHERE id = p_cargo_id;
  IF v_cargo.id IS NULL OR v_cargo.tenant_id <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'CARGO_NO_EXISTE: Ese cargo no es de este gimnasio';
  END IF;
  IF v_cargo.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'CARGO_NO_PENDIENTE: Ese cargo ya está % (no se puede cobrar de nuevo)', v_cargo.estado;
  END IF;
  IF p_metodo NOT IN ('efectivo','tarjeta','transferencia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: Método de pago no válido';
  END IF;

  -- Nace el pago real → entra a la Caja como ingreso.
  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id, concepto, monto_centavos, moneda, metodo, referencia, notas, cobrado_por
  ) VALUES (
    v_cargo.tenant_id, v_cargo.sucursal_id, v_cargo.usuario_id, v_cargo.concepto,
    v_cargo.monto_centavos, v_cargo.moneda, p_metodo, NULL,
    'Cobro de pendiente' || COALESCE(' · ' || v_cargo.descripcion, ''), get_my_user_id()
  )
  RETURNING id INTO v_pago_id;

  UPDATE cargos_pendientes
  SET estado = 'cobrado', pago_id = v_pago_id, cobrado_at = now()
  WHERE id = p_cargo_id;

  RETURN jsonb_build_object('success', true, 'pago_id', v_pago_id, 'monto_centavos', v_cargo.monto_centavos);
END;
$$;

-- ── Cancelar un cargo pendiente (no lo van a pagar) ─────────────────────────
CREATE OR REPLACE FUNCTION cancelar_cargo_pendiente(
  p_cargo_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cargo cargos_pendientes;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden cancelar';
  END IF;
  SELECT * INTO v_cargo FROM cargos_pendientes WHERE id = p_cargo_id;
  IF v_cargo.id IS NULL OR v_cargo.tenant_id <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'CARGO_NO_EXISTE: Ese cargo no es de este gimnasio';
  END IF;
  IF v_cargo.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'CARGO_NO_PENDIENTE: Ese cargo ya está %', v_cargo.estado;
  END IF;

  UPDATE cargos_pendientes
  SET estado = 'cancelado', motivo_cancelacion = NULLIF(trim(p_motivo), '')
  WHERE id = p_cargo_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION registrar_cargo_pendiente(uuid, integer, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION cobrar_cargo_pendiente(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION cancelar_cargo_pendiente(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_cargo_pendiente(uuid, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION cobrar_cargo_pendiente(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION cancelar_cargo_pendiente(uuid, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- SELF-TEST funcional (dinero de verdad): tenant desechable + admin simulado.
-- registrar → hay 1 pendiente y CERO ingreso; cobrar → nace el pago (ingreso) y el
-- cargo queda 'cobrado'. Limpia con cerrar_tenant.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tenant uuid; v_admin uuid; v_socio uuid;
  v_auth uuid := gen_random_uuid();
  v_slug text := 'zz-test-porcobrar-' || substr(md5(random()::text), 1, 6);
  v_res jsonb; v_cargo uuid; v_por_cobrar int; v_ingreso int;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test por cobrar', 'gym_libre', 'activo') RETURNING id INTO v_tenant;

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, raw_user_meta_data,
    encrypted_password, email_confirmed_at, created_at, updated_at
  ) VALUES (
    v_auth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    v_slug || '-admin@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'),
    '', now(), now(), now()
  );
  UPDATE usuarios SET rol = 'admin', status = 'activo' WHERE auth_id = v_auth RETURNING id INTO v_admin;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'FALLA: signup no creó admin'; END IF;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug || '-socio@sala.dev', 'Socio', 'miembro', 'activo') RETURNING id INTO v_socio;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- 1) Registrar un day pass de $150 por cobrar.
  v_res := registrar_cargo_pendiente(v_socio, 15000, 'plan', 'Day Pass jueves');
  v_cargo := (v_res->>'cargo_id')::uuid;

  SELECT COALESCE(SUM(monto_centavos),0) INTO v_por_cobrar
  FROM cargos_pendientes WHERE tenant_id = v_tenant AND estado = 'pendiente';
  IF v_por_cobrar <> 15000 THEN RAISE EXCEPTION 'FALLA: por cobrar esperaba 15000, fue %', v_por_cobrar; END IF;

  SELECT COALESCE(SUM(monto_centavos),0) INTO v_ingreso
  FROM pagos WHERE tenant_id = v_tenant AND metodo <> 'cortesia';
  IF v_ingreso <> 0 THEN RAISE EXCEPTION 'FALLA: aún no debe haber ingreso, hubo %', v_ingreso; END IF;

  -- 2) Llega y paga en efectivo → nace el pago, el cargo queda cobrado.
  PERFORM cobrar_cargo_pendiente(v_cargo, 'efectivo');

  IF (SELECT estado FROM cargos_pendientes WHERE id = v_cargo) <> 'cobrado' THEN
    RAISE EXCEPTION 'FALLA: el cargo no quedó cobrado';
  END IF;
  SELECT COALESCE(SUM(monto_centavos),0) INTO v_ingreso
  FROM pagos WHERE tenant_id = v_tenant AND metodo <> 'cortesia';
  IF v_ingreso <> 15000 THEN RAISE EXCEPTION 'FALLA: al cobrar debía haber 15000 de ingreso, hubo %', v_ingreso; END IF;

  -- 3) No se puede cobrar dos veces.
  BEGIN
    PERFORM cobrar_cargo_pendiente(v_cargo, 'efectivo');
    RAISE EXCEPTION 'FALLA: dejó cobrar un cargo ya cobrado';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'CARGO_NO_PENDIENTE%' AND SQLERRM NOT LIKE 'FALLA%' THEN RAISE; END IF;
    IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
END;
$$;

SELECT
  'cargos pendientes (por cobrar)' AS prueba,
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'cargos_pendientes') AS tabla_ok,
  (SELECT count(*) FROM pg_proc WHERE proname IN
     ('registrar_cargo_pendiente','cobrar_cargo_pendiente','cancelar_cargo_pendiente')) AS rpcs_ok,
  NOT has_function_privilege('anon', 'cobrar_cargo_pendiente(uuid, text)', 'EXECUTE') AS anon_bloqueado;