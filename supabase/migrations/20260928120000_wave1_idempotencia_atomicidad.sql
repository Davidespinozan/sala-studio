-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Envuelto en BEGIN/COMMIT: la migración es TODO-O-NADA por el propio artefacto,
-- sin depender del comportamiento del SQL Editor/cliente. Si CUALQUIER statement
-- (incl. un error en un self-test de abajo) falla, se revierte la migración entera.
-- ============================================================================
BEGIN;

-- ============================================================================
-- WAVE 1 — Idempotencia de operaciones de dinero (Economía A) + AsignarPlan atómico
-- RC-01 (idempotencia) + RC-02 (atomicidad de la asignación de plan en recepción)
-- ----------------------------------------------------------------------------
-- QUÉ RESUELVE
--   Hoy ninguna operación de dinero de mostrador tiene llave de idempotencia:
--   `pagos.referencia` es NULL en todos los flujos de recepción. Si la respuesta
--   se pierde (timeout / se cae internet tras "Cobrar") y el operador reintenta,
--   se duplica: 2ª venta POS + 2× stock, 2º reembolso, re-renovación, 2º cargo.
--   Además "Asignar plan" son 3 RPC sueltas en el cliente (exentar → asignar →
--   dejar pendiente): un fallo a mitad deja el plan puesto pero el "por cobrar"
--   perdido.
--
-- CÓMO
--   • Registro angosto `business_operations`: 1 fila por (tenant_id, operation_key).
--     El cliente genera un UUID por INTENCIÓN de negocio; sobrevive al reintento.
--       - misma key + mismo payload  → converge al resultado original (no re-ejecuta)
--       - misma key + payload distinto → IDEMPOTENCY_CONFLICT (no ejecuta nada)
--   • `p_operation_key uuid DEFAULT NULL` en las 9 RPCs in-scope. NULL = comportamiento
--     de hoy (aditivo, retrocompatible; sin backfill de filas históricas).
--   • Operaciones anidadas: el wrapper es dueño de la key y llama a las RPC internas
--     SIN key (NULL) → la interna no re-registra. CERO estado transaccional/GUC → no
--     hay fuga entre transacciones.
--   • `recepcion_asignar_plan` se vuelve ATÓMICA (exentar + asignar + cargo en UNA
--     transacción de Postgres). La atomicidad se ACTIVA solo cuando el frontend nuevo
--     manda los flags; con el frontend viejo se comporta igual que hoy.
--
-- NO TOCA: pagos append-only, pagos.referencia (folio Stripe), precios server-side,
--   RLS/tenancy, salas con mapa, reservas, check-in, corte de caja, Stripe, créditos.
-- ============================================================================

-- ── A) REGISTRO DE OPERACIONES ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_operations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operation_key uuid NOT NULL,
  tipo          text NOT NULL,
  actor_id      uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  payload_hash  text NOT NULL,
  resultado     jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- La garantía entera de dedup vive acá:
CREATE UNIQUE INDEX IF NOT EXISTS business_operations_key
  ON business_operations (tenant_id, operation_key);

COMMENT ON TABLE business_operations IS
  'Registro de idempotencia (Wave 1): 1 fila por (tenant, operation_key). La escriben/leen SOLO las RPC SECURITY DEFINER de dinero. Una key = una intención de negocio; el reintento converge al resultado guardado. No es un ledger; no reemplaza a pagos.';

-- Solo las RPC SECURITY DEFINER (corren como owner y saltan RLS) la tocan.
-- Sin policies para authenticated/anon: acceso directo denegado.
ALTER TABLE business_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON business_operations FROM PUBLIC;
REVOKE ALL ON business_operations FROM anon;
REVOKE ALL ON business_operations FROM authenticated;

-- ── B) HELPERS DE IDEMPOTENCIA ──────────────────────────────────────────────
-- _op_begin: reclama la operación o converge a la existente.
--   claimed=true  → esta transacción es la dueña; seguir con el trabajo.
--   claimed=false → ya existía y coincide el payload; devolver 'resultado'.
--   payload distinto → IDEMPOTENCY_CONFLICT.
-- La fila del registro y la mutación de negocio comparten la MISMA transacción:
-- si el trabajo hace rollback, la fila se va también → la key NO queda consumida.
CREATE OR REPLACE FUNCTION _op_begin(
  p_tenant uuid, p_key uuid, p_tipo text, p_actor uuid, p_payload_hash text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row business_operations;
BEGIN
  -- INSERT ON CONFLICT DO NOTHING: si otra tx tiene una fila sin commitear con la
  -- misma key, ESTE INSERT se bloquea hasta que aquella haga commit/rollback, y
  -- recién ahí resuelve el conflicto. Así queda cubierta la concurrencia real.
  INSERT INTO business_operations (tenant_id, operation_key, tipo, actor_id, payload_hash)
  VALUES (p_tenant, p_key, p_tipo, p_actor, p_payload_hash)
  ON CONFLICT (tenant_id, operation_key) DO NOTHING;

  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true);
  END IF;

  -- Ya existía (commit de la otra tx). Bloquear la fila para leer su resultado final.
  SELECT * INTO v_row FROM business_operations
  WHERE tenant_id = p_tenant AND operation_key = p_key
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Rarísimo: la otra tx hizo rollback justo después de resolver el conflicto.
    -- Reintentar el claim una vez.
    INSERT INTO business_operations (tenant_id, operation_key, tipo, actor_id, payload_hash)
    VALUES (p_tenant, p_key, p_tipo, p_actor, p_payload_hash)
    ON CONFLICT (tenant_id, operation_key) DO NOTHING;
    IF FOUND THEN
      RETURN jsonb_build_object('claimed', true);
    END IF;
    SELECT * INTO v_row FROM business_operations
    WHERE tenant_id = p_tenant AND operation_key = p_key
    FOR UPDATE;
  END IF;

  IF v_row.payload_hash IS DISTINCT FROM p_payload_hash THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: esa operación ya se registró con datos distintos';
  END IF;

  RETURN jsonb_build_object('claimed', false, 'resultado', v_row.resultado);
END;
$$;

CREATE OR REPLACE FUNCTION _op_finish(p_tenant uuid, p_key uuid, p_resultado jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE business_operations
  SET resultado = p_resultado
  WHERE tenant_id = p_tenant AND operation_key = p_key;
END;
$$;

-- Solo las RPC de dinero (SECURITY DEFINER, corren como owner) las invocan.
REVOKE ALL ON FUNCTION _op_begin(uuid, uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION _op_finish(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- ── C) RPCs HOJA (reciben key directa del cliente; no llaman a otra RPC de dinero)
-- Se recrean con p_operation_key uuid DEFAULT NULL. El bloque de idempotencia va
-- después de las validaciones baratas y ANTES de mutar. Si algo falla luego, la
-- fila del registro hace rollback con todo (key libre para un reintento corregido).

-- ── C1) vender_productos (POS) ──────────────────────────────────────────────
DROP FUNCTION IF EXISTS vender_productos(uuid, text, jsonb, uuid);
CREATE OR REPLACE FUNCTION vender_productos(
  p_sucursal_id uuid,
  p_metodo text,
  p_items jsonb,
  p_usuario_id uuid DEFAULT NULL,
  p_operation_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller usuarios;
  v_item jsonb;
  v_prod productos;
  v_cant integer;
  v_total integer := 0;
  v_moneda text := 'MXN';
  v_pago_id uuid;
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  SELECT * INTO v_caller FROM usuarios WHERE auth_id = auth.uid();
  IF v_caller.id IS NULL OR v_caller.rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin pueden vender';
  END IF;
  IF v_caller.status <> 'activo' THEN
    RAISE EXCEPTION 'CUENTA_INACTIVA';
  END IF;

  IF p_metodo NOT IN ('efectivo', 'tarjeta', 'transferencia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO';
  END IF;
  IF jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'SIN_ITEMS';
  END IF;

  -- Idempotencia. Los items no tienen orden semántico → se canonicalizan ordenados
  -- por producto_id antes de hashear.
  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_caller.tenant_id, p_operation_key, 'pos_venta', v_caller.id,
      md5(jsonb_build_object(
        'sucursal', p_sucursal_id, 'metodo', p_metodo, 'usuario', p_usuario_id,
        'items', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('p', e->>'producto_id', 'c', e->>'cantidad') ORDER BY e->>'producto_id')
          FROM jsonb_array_elements(p_items) e
        ), '[]'::jsonb)
      )::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  IF p_sucursal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sucursales WHERE id = p_sucursal_id AND tenant_id = v_caller.tenant_id
  ) THEN
    RAISE EXCEPTION 'SUCURSAL_INVALIDA: esa sucursal no es de este gimnasio';
  END IF;
  IF p_usuario_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM usuarios WHERE id = p_usuario_id AND tenant_id = v_caller.tenant_id
  ) THEN
    RAISE EXCEPTION 'SOCIO_INVALIDO: ese socio no es de este gimnasio';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_prod FROM productos WHERE id = (v_item->>'producto_id')::uuid;
    IF v_prod.id IS NULL OR v_prod.tenant_id <> v_caller.tenant_id THEN
      RAISE EXCEPTION 'PRODUCTO_INVALIDO';
    END IF;
    IF v_prod.activo IS NOT TRUE THEN
      RAISE EXCEPTION 'PRODUCTO_INACTIVO: %', v_prod.nombre;
    END IF;
    v_cant := COALESCE((v_item->>'cantidad')::integer, 0);
    IF v_cant <= 0 THEN
      RAISE EXCEPTION 'CANTIDAD_INVALIDA';
    END IF;
    v_total := v_total + v_prod.precio_centavos * v_cant;
    v_moneda := v_prod.moneda;
  END LOOP;

  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id, concepto, monto_centavos, moneda, metodo, cobrado_por
  ) VALUES (
    v_caller.tenant_id, p_sucursal_id, p_usuario_id, 'producto', v_total, v_moneda, p_metodo, v_caller.id
  )
  RETURNING id INTO v_pago_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO producto_movimientos (
      tenant_id, producto_id, sucursal_id, tipo, cantidad, pago_id, created_by
    ) VALUES (
      v_caller.tenant_id, (v_item->>'producto_id')::uuid, p_sucursal_id,
      'venta', -((v_item->>'cantidad')::integer), v_pago_id, v_caller.id
    );
  END LOOP;

  v_result := jsonb_build_object('pago_id', v_pago_id, 'total_centavos', v_total, 'moneda', v_moneda);
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_caller.tenant_id, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END; $$;

REVOKE ALL ON FUNCTION vender_productos(uuid, text, jsonb, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vender_productos(uuid, text, jsonb, uuid, uuid) TO authenticated;

-- ── C2) registrar_reembolso ─────────────────────────────────────────────────
DROP FUNCTION IF EXISTS registrar_reembolso(uuid, integer, text);
CREATE OR REPLACE FUNCTION registrar_reembolso(
  p_pago_id uuid,
  p_monto_centavos integer DEFAULT NULL,
  p_motivo text DEFAULT NULL,
  p_operation_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_pago pagos;
  v_socio usuarios;
  v_disponible integer;
  v_monto integer;
  v_reembolso_id uuid;
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden devolver dinero';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: Un reembolso sin motivo no se puede auditar después';
  END IF;

  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'reembolso', v_actor,
      md5(jsonb_build_object('pago', p_pago_id, 'monto', p_monto_centavos, 'motivo', trim(p_motivo))::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  SELECT * INTO v_pago FROM pagos WHERE id = p_pago_id;
  IF v_pago.id IS NULL THEN
    RAISE EXCEPTION 'PAGO_NO_EXISTE: No encontramos ese cobro';
  END IF;
  IF v_pago.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Ese cobro es de otro gimnasio';
  END IF;
  IF v_pago.concepto = 'reembolso' THEN
    RAISE EXCEPTION 'NO_REEMBOLSABLE: Eso ya es un reembolso, no un cobro';
  END IF;
  IF v_pago.metodo = 'cortesia' THEN
    RAISE EXCEPTION 'NO_REEMBOLSABLE: Una cortesía no cobró nada';
  END IF;

  v_disponible := pago_reembolsable(p_pago_id);
  IF v_disponible <= 0 THEN
    RAISE EXCEPTION 'YA_REEMBOLSADO: Ese cobro ya se devolvió por completo';
  END IF;

  v_monto := COALESCE(p_monto_centavos, v_disponible);
  IF v_monto <= 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO: El monto a devolver tiene que ser mayor a cero';
  END IF;
  IF v_monto > v_disponible THEN
    RAISE EXCEPTION 'MONTO_EXCEDE: De ese cobro quedan % por devolver, no %',
      (v_disponible / 100.0)::numeric(12,2), (v_monto / 100.0)::numeric(12,2);
  END IF;

  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
    concepto, monto_centavos, moneda, metodo,
    referencia, notas, cobrado_por, revierte_pago_id
  ) VALUES (
    v_tenant, v_pago.sucursal_id, v_pago.usuario_id, v_pago.membresia_id, v_pago.tier_id,
    'reembolso', -v_monto, v_pago.moneda, v_pago.metodo,
    NULL, trim(p_motivo), v_actor, p_pago_id
  )
  RETURNING id INTO v_reembolso_id;

  SELECT * INTO v_socio FROM usuarios WHERE id = v_pago.usuario_id;

  PERFORM _audrec_log(
    'pago.reembolso', 'pago', v_reembolso_id, v_pago.usuario_id, v_socio.nombre,
    format('Devolvió %s (%s) del cobro de %s. Motivo: %s',
           to_char(v_monto / 100.0, 'FM999G999G990D00'),
           v_pago.metodo,
           to_char(v_pago.created_at, 'DD/MM/YYYY'),
           trim(p_motivo)),
    jsonb_build_object(
      'pago_original_id', p_pago_id,
      'monto_centavos', v_monto,
      'metodo', v_pago.metodo,
      'moneda', v_pago.moneda
    )
  );

  v_result := jsonb_build_object(
    'success', true,
    'reembolso_id', v_reembolso_id,
    'monto_centavos', v_monto,
    'moneda', v_pago.moneda,
    'metodo', v_pago.metodo,
    'pendiente_centavos', v_disponible - v_monto,
    'requiere_accion_en_stripe', v_pago.metodo = 'stripe'
  );
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION registrar_reembolso(uuid, integer, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_reembolso(uuid, integer, text, uuid) TO authenticated;

-- ── C3) registrar_cargo_pendiente ───────────────────────────────────────────
DROP FUNCTION IF EXISTS registrar_cargo_pendiente(uuid, integer, text, text);
CREATE OR REPLACE FUNCTION registrar_cargo_pendiente(
  p_usuario_id uuid,
  p_monto_centavos integer,
  p_concepto text DEFAULT 'plan',
  p_descripcion text DEFAULT NULL,
  p_operation_key uuid DEFAULT NULL
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
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden registrar un cargo';
  END IF;
  IF p_monto_centavos IS NULL OR p_monto_centavos <= 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO: El monto por cobrar debe ser mayor a 0';
  END IF;

  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'cargo', get_my_user_id(),
      md5(jsonb_build_object('usuario', p_usuario_id, 'monto', p_monto_centavos,
                             'concepto', p_concepto, 'desc', p_descripcion)::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
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

  v_result := jsonb_build_object('success', true, 'cargo_id', v_id, 'monto_centavos', p_monto_centavos);
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION registrar_cargo_pendiente(uuid, integer, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_cargo_pendiente(uuid, integer, text, text, uuid) TO authenticated;

-- ── C4) cobrar_cargo_pendiente ──────────────────────────────────────────────
DROP FUNCTION IF EXISTS cobrar_cargo_pendiente(uuid, text);
CREATE OR REPLACE FUNCTION cobrar_cargo_pendiente(
  p_cargo_id uuid,
  p_metodo text DEFAULT 'efectivo',
  p_operation_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cargo cargos_pendientes;
  v_pago_id uuid;
  v_tenant uuid := get_my_tenant_id();
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden cobrar';
  END IF;
  IF p_metodo NOT IN ('efectivo','tarjeta','transferencia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: Método de pago no válido';
  END IF;

  -- Idempotencia ANTES del guard de estado: un reintento con la misma key devuelve
  -- el pago original (already_processed) en vez del confuso CARGO_NO_PENDIENTE.
  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'cobro_cargo', get_my_user_id(),
      md5(jsonb_build_object('cargo', p_cargo_id, 'metodo', p_metodo)::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  SELECT * INTO v_cargo FROM cargos_pendientes WHERE id = p_cargo_id;
  IF v_cargo.id IS NULL OR v_cargo.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'CARGO_NO_EXISTE: Ese cargo no es de este gimnasio';
  END IF;
  IF v_cargo.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'CARGO_NO_PENDIENTE: Ese cargo ya está % (no se puede cobrar de nuevo)', v_cargo.estado;
  END IF;

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

  v_result := jsonb_build_object('success', true, 'pago_id', v_pago_id, 'monto_centavos', v_cargo.monto_centavos);
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION cobrar_cargo_pendiente(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cobrar_cargo_pendiente(uuid, text, uuid) TO authenticated;

-- ── C5) gestionar_membresia_socio (motor; cubre recepción + admin) ──────────
-- Se agrega p_operation_key como 7º parámetro (default NULL). Registra SOLO cuando
-- lo llaman DIRECTO con key (camino admin). Los wrappers de recepción son dueños de
-- su propia key y llaman al motor SIN key (5 args) → acá no re-registra. Todo lo
-- demás VERBATIM de 20260819210000.
DROP FUNCTION IF EXISTS gestionar_membresia_socio(uuid, uuid, text, text, integer, boolean);
CREATE OR REPLACE FUNCTION gestionar_membresia_socio(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_motivo text DEFAULT NULL,
  p_metodo_pago text DEFAULT NULL,
  p_monto_centavos integer DEFAULT NULL,
  p_confirmar_perdida boolean DEFAULT false,
  p_operation_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
  v_actor_tenant_id uuid;
  v_socio usuarios;
  v_tier tiers;
  v_now timestamptz := now();
  v_anterior_id uuid;
  v_anterior_fin timestamptz;
  v_anterior_saldo integer;
  v_anterior_tier_tipo text;
  v_anterior_es_pase boolean;
  v_existe_anterior boolean := false;
  v_mismo_tipo boolean := false;
  v_nuevo_fin timestamptz;
  v_nuevo_saldo integer;
  v_modo text;
  v_delta_creditos integer;
  v_membresia_id uuid;
  v_motivo_final text;
  v_monto_plan integer;
  v_cobra_inscripcion boolean := false;
  v_inscripcion integer := 0;
  v_sucursal_id uuid;
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  v_actor_id := get_my_user_id();
  v_actor_tenant_id := get_my_tenant_id();
  IF v_actor_id IS NULL OR v_actor_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff (admin/recepción) puede gestionar membresías';
  END IF;

  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_actor_tenant_id, p_operation_key, 'membresia', v_actor_id,
      md5(jsonb_build_object('usuario', p_usuario_id, 'tier', p_tier_id, 'motivo', p_motivo,
                             'metodo', p_metodo_pago, 'monto', p_monto_centavos,
                             'confirmar', p_confirmar_perdida)::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE: El socio no existe';
  END IF;
  IF v_socio.tenant_id <> v_actor_tenant_id THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: El socio no pertenece a tu gimnasio';
  END IF;
  IF v_socio.rol <> 'miembro' THEN
    RAISE EXCEPTION 'ROL_INVALIDO: Solo se pueden asignar membresías a usuarios con rol miembro';
  END IF;

  SELECT * INTO v_tier FROM tiers WHERE id = p_tier_id;
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE: El tier no existe';
  END IF;
  IF v_tier.tenant_id <> v_socio.tenant_id THEN
    RAISE EXCEPTION 'TIER_TENANT_INVALIDO: El tier no pertenece al mismo gimnasio que el socio';
  END IF;
  IF NOT v_tier.activo THEN
    RAISE EXCEPTION 'TIER_INACTIVO: El tier no está activo. Activalo desde Planes antes de asignarlo';
  END IF;

  IF p_metodo_pago IS NOT NULL
     AND p_metodo_pago NOT IN ('efectivo', 'tarjeta', 'transferencia', 'cortesia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: Método de pago no válido (%)', p_metodo_pago;
  END IF;

  SELECT m.id, m.periodo_actual_fin, m.creditos_restantes, t.tipo, COALESCE(t.es_pase, false)
  INTO v_anterior_id, v_anterior_fin, v_anterior_saldo, v_anterior_tier_tipo, v_anterior_es_pase
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada', 'expirada')
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  v_existe_anterior := v_anterior_id IS NOT NULL;
  v_mismo_tipo := v_existe_anterior AND v_anterior_tier_tipo = v_tier.tipo;

  IF NOT v_existe_anterior THEN
    v_modo := 'alta';
    v_nuevo_fin := CASE
      WHEN v_tier.duracion_dias IS NULL THEN NULL
      ELSE v_now + (v_tier.duracion_dias || ' days')::interval
    END;
    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE v_tier.clases_incluidas
    END;
  ELSIF v_mismo_tipo THEN
    IF v_tier.duracion_dias IS NULL THEN
      v_nuevo_fin := NULL;
      v_modo := 'renovacion';
    ELSIF NOT COALESCE(v_tier.es_pase, false)
          AND NOT COALESCE(v_anterior_es_pase, false)
          AND v_anterior_fin IS NOT NULL AND v_anterior_fin > v_now THEN
      v_nuevo_fin := v_anterior_fin + (v_tier.duracion_dias || ' days')::interval;
      v_modo := 'renovacion';
    ELSE
      v_nuevo_fin := v_now + (v_tier.duracion_dias || ' days')::interval;
      v_modo := 'renovacion_desde_hoy';
    END IF;
    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE COALESCE(v_anterior_saldo, 0) + COALESCE(v_tier.clases_incluidas, 0)
    END;
  ELSE
    v_modo := 'cambio_de_tipo';
    v_nuevo_fin := CASE
      WHEN v_tier.duracion_dias IS NULL THEN NULL
      ELSE v_now + (v_tier.duracion_dias || ' days')::interval
    END;
    v_nuevo_saldo := CASE
      WHEN v_tier.tipo = 'tiempo' THEN NULL
      ELSE v_tier.clases_incluidas
    END;
  END IF;

  v_delta_creditos := COALESCE(v_nuevo_saldo, 0) - COALESCE(v_anterior_saldo, 0);

  IF v_modo = 'cambio_de_tipo'
     AND COALESCE(v_anterior_saldo, 0) > 0
     AND NOT COALESCE(p_confirmar_perdida, false) THEN
    RAISE EXCEPTION
      'CREDITOS_SE_PIERDEN: El socio tiene % clase(s) sin usar. Cambiar a este plan las borra. Confirmá el cambio si es lo que querés.',
      v_anterior_saldo;
  END IF;

  IF v_existe_anterior THEN
    UPDATE membresias
    SET tier_id = p_tier_id,
        status = 'activa',
        periodo_actual_inicio = v_now,
        periodo_actual_fin = v_nuevo_fin,
        creditos_restantes = v_nuevo_saldo,
        updated_at = v_now
    WHERE id = v_anterior_id;
    v_membresia_id := v_anterior_id;
  ELSE
    INSERT INTO membresias (
      tenant_id, usuario_id, tier_id, status,
      periodo_actual_inicio, periodo_actual_fin, creditos_restantes
    ) VALUES (
      v_socio.tenant_id, p_usuario_id, p_tier_id, 'activa',
      v_now, v_nuevo_fin, v_nuevo_saldo
    )
    RETURNING id INTO v_membresia_id;
  END IF;

  v_motivo_final := COALESCE(
    NULLIF(trim(p_motivo), ''),
    format('%s — tier %s', v_modo, v_tier.slug)
  );

  IF v_modo = 'cambio_de_tipo' AND COALESCE(v_anterior_saldo, 0) > 0 THEN
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'expiracion', -v_anterior_saldo,
      NULL, format('créditos perdidos por cambio de plan (tier %s)', v_tier.slug), v_actor_id
    );
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'alta', COALESCE(v_nuevo_saldo, 0),
      NULL, v_motivo_final, v_actor_id
    );
  ELSE
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
    ) VALUES (
      v_membresia_id, v_socio.tenant_id, 'alta', v_delta_creditos,
      NULL, v_motivo_final, v_actor_id
    );
  END IF;

  IF p_metodo_pago IS NOT NULL THEN
    v_monto_plan := COALESCE(p_monto_centavos, v_tier.precio_centavos, 0);
    SELECT sucursal_id INTO v_sucursal_id FROM membresias WHERE id = v_membresia_id;

    IF v_monto_plan > 0 THEN
      INSERT INTO pagos (
        tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
        concepto, monto_centavos, moneda, metodo, notas, cobrado_por
      ) VALUES (
        v_socio.tenant_id, v_sucursal_id, p_usuario_id, v_membresia_id, p_tier_id,
        CASE WHEN v_tier.tipo IN ('creditos', 'hibrido') THEN 'paquete' ELSE 'plan' END,
        v_monto_plan, COALESCE(v_tier.moneda, 'MXN'), p_metodo_pago, v_motivo_final, v_actor_id
      );
    END IF;

    v_inscripcion := COALESCE(v_tier.inscripcion_centavos, 0);
    v_cobra_inscripcion := v_inscripcion > 0
      AND v_socio.inscripcion_pagada_at IS NULL
      AND v_modo = 'alta'
      AND NOT EXISTS (
        SELECT 1 FROM membresias
        WHERE usuario_id = p_usuario_id AND id <> v_membresia_id
      );

    IF v_cobra_inscripcion THEN
      INSERT INTO pagos (
        tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
        concepto, monto_centavos, moneda, metodo, notas, cobrado_por
      ) VALUES (
        v_socio.tenant_id, v_sucursal_id, p_usuario_id, v_membresia_id, p_tier_id,
        'inscripcion', v_inscripcion, COALESCE(v_tier.moneda, 'MXN'), p_metodo_pago,
        'inscripción', v_actor_id
      );
      UPDATE usuarios SET inscripcion_pagada_at = v_now WHERE id = p_usuario_id;
    END IF;
  END IF;

  UPDATE usuarios
  SET membresia_tier = v_tier.slug,
      membresia_activa_id = v_membresia_id,
      status = CASE WHEN status = 'pendiente_pago' THEN 'activo' ELSE status END
  WHERE id = p_usuario_id;

  v_result := jsonb_build_object(
    'success', true,
    'membresia_id', v_membresia_id,
    'modo', v_modo,
    'tier_slug', v_tier.slug,
    'tier_nombre', v_tier.nombre,
    'tier_tipo', v_tier.tipo,
    'periodo_actual_fin', v_nuevo_fin,
    'creditos_restantes', v_nuevo_saldo,
    'delta_creditos', v_delta_creditos,
    'cobro_registrado', p_metodo_pago IS NOT NULL,
    'monto_plan_centavos', COALESCE(v_monto_plan, 0),
    'inscripcion_centavos', CASE WHEN v_cobra_inscripcion THEN v_inscripcion ELSE 0 END
  );
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_actor_tenant_id, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION gestionar_membresia_socio(uuid, uuid, text, text, integer, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION gestionar_membresia_socio(uuid, uuid, text, text, integer, boolean, uuid) TO authenticated;

-- ── D) WRAPPERS (dueños de la key; llaman a las internas SIN key = anidado NULL)

-- ── D1) reembolsar_como_cortesia ────────────────────────────────────────────
DROP FUNCTION IF EXISTS reembolsar_como_cortesia(uuid, integer, text);
CREATE OR REPLACE FUNCTION reembolsar_como_cortesia(
  p_pago_id uuid,
  p_monto_centavos integer DEFAULT NULL,
  p_motivo text DEFAULT NULL,
  p_operation_key uuid DEFAULT NULL
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
  v_tenant uuid := get_my_tenant_id();
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden hacer esto';
  END IF;

  SELECT * INTO v_pago FROM pagos WHERE id = p_pago_id;
  IF v_pago.id IS NULL THEN
    RAISE EXCEPTION 'PAGO_NO_EXISTE: no encontramos ese cobro';
  END IF;
  IF v_pago.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: ese cobro no es de tu gimnasio';
  END IF;

  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'reembolso_cortesia', v_actor,
      md5(jsonb_build_object('pago', p_pago_id, 'monto', p_monto_centavos, 'motivo', trim(p_motivo))::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  -- Anidado SIN key: registrar_reembolso no re-registra.
  v_res := registrar_reembolso(p_pago_id, p_monto_centavos, COALESCE(NULLIF(trim(p_motivo), ''), 'Fue cortesía'));
  v_monto := (v_res->>'monto_centavos')::integer;

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

  v_result := jsonb_build_object(
    'success', true,
    'reembolso_id', v_res->>'reembolso_id',
    'cortesia_id', v_cortesia_id,
    'monto_centavos', v_monto
  );
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION reembolsar_como_cortesia(uuid, integer, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reembolsar_como_cortesia(uuid, integer, text, uuid) TO authenticated;

-- ── D2) cancelar_venta_producto ─────────────────────────────────────────────
DROP FUNCTION IF EXISTS cancelar_venta_producto(uuid, text);
CREATE OR REPLACE FUNCTION cancelar_venta_producto(
  p_pago_id uuid,
  p_motivo text,
  p_operation_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_pago   pagos;
  v_mov    record;
  v_reembolso jsonb;
  v_op jsonb;
  v_owns boolean := false;
  v_result jsonb;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden cancelar una venta';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: Una cancelación sin motivo no se puede auditar después';
  END IF;

  SELECT * INTO v_pago FROM pagos WHERE id = p_pago_id;
  IF v_pago.id IS NULL THEN
    RAISE EXCEPTION 'PAGO_NO_EXISTE: No encontramos esa venta';
  END IF;
  IF v_pago.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esa venta es de otro gimnasio';
  END IF;
  IF v_pago.concepto <> 'producto' THEN
    RAISE EXCEPTION 'NO_ES_VENTA_PRODUCTO: Ese cobro no es una venta de la tienda';
  END IF;

  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'cancelar_venta', get_my_user_id(),
      md5(jsonb_build_object('pago', p_pago_id, 'motivo', trim(p_motivo))::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  -- Anidado SIN key.
  v_reembolso := registrar_reembolso(p_pago_id, NULL, p_motivo);

  FOR v_mov IN
    SELECT producto_id, sucursal_id, cantidad
    FROM producto_movimientos
    WHERE pago_id = p_pago_id AND tipo = 'venta'
  LOOP
    INSERT INTO producto_movimientos (tenant_id, producto_id, sucursal_id, tipo, cantidad, motivo, created_by)
    VALUES (
      v_tenant, v_mov.producto_id, v_mov.sucursal_id, 'devolucion',
      -v_mov.cantidad,
      'Cancelación de venta: ' || trim(p_motivo), get_my_user_id()
    );
  END LOOP;

  v_result := jsonb_build_object('ok', true, 'reembolso', v_reembolso);
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION cancelar_venta_producto(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancelar_venta_producto(uuid, text, uuid) TO authenticated;

COMMENT ON FUNCTION cancelar_venta_producto(uuid, text, uuid) IS
  'Deshace una venta de la Tienda: reversa el dinero (registrar_reembolso) y devuelve el stock. Idempotente por operation_key (Wave 1) + candado de reembolso.';

-- ── D3) recepcion_asignar_plan — ATÓMICO (exentar + asignar + cargo en 1 tx) ──
-- Flags nuevos (default false/NULL): con el frontend viejo (que manda solo 4 args)
-- se comporta EXACTO como hoy (solo asigna+cobra). La atomicidad se activa cuando
-- el frontend nuevo manda p_exentar_inscripcion / p_dejar_pendiente.
DROP FUNCTION IF EXISTS recepcion_asignar_plan(uuid, uuid, text, text, integer);
CREATE OR REPLACE FUNCTION recepcion_asignar_plan(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_motivo text,
  p_metodo_pago text DEFAULT NULL,
  p_monto_centavos integer DEFAULT NULL,
  p_operation_key uuid DEFAULT NULL,
  p_exentar_inscripcion boolean DEFAULT false,
  p_dejar_pendiente boolean DEFAULT false,
  p_cargo_monto_centavos integer DEFAULT NULL,
  p_cargo_descripcion text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_socio_nombre text;
  v_tiene_membresia boolean;
  v_mem_id uuid;
  v_resultado jsonb;
  v_cargo jsonb := NULL;
  v_tenant uuid := get_my_tenant_id();
  v_op jsonb;
  v_owns boolean := false;
BEGIN
  IF NOT (is_recepcionista() OR is_admin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tiers WHERE id = p_tier_id) THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE: el plan no existe';
  END IF;

  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'membresia_asignar', get_my_user_id(),
      md5(jsonb_build_object('usuario', p_usuario_id, 'tier', p_tier_id, 'motivo', p_motivo,
                             'metodo', p_metodo_pago, 'monto', p_monto_centavos,
                             'exentar', p_exentar_inscripcion, 'pendiente', p_dejar_pendiente,
                             'cargo_monto', p_cargo_monto_centavos, 'cargo_desc', p_cargo_descripcion)::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM membresias
    WHERE usuario_id = p_usuario_id
      AND status IN ('activa', 'congelada', 'past_due')
  ) INTO v_tiene_membresia;
  IF v_tiene_membresia THEN
    RAISE EXCEPTION 'MEMBRESIA_YA_EXISTE: el socio ya tiene una membresía activa o pausada. Usá cambiar plan en su lugar';
  END IF;

  SELECT nombre INTO v_socio_nombre FROM usuarios WHERE id = p_usuario_id;
  IF v_socio_nombre IS NULL THEN
    RAISE EXCEPTION 'SOCIO_NO_EXISTE: el socio no existe';
  END IF;

  -- (1) Exentar inscripción ANTES de asignar (para que el motor no la cobre).
  IF p_exentar_inscripcion THEN
    PERFORM exentar_inscripcion_socio(p_usuario_id);
  END IF;

  -- (2) Asignar + cobrar (motor, anidado SIN key).
  SELECT gestionar_membresia_socio(p_usuario_id, p_tier_id, p_motivo, p_metodo_pago, p_monto_centavos)
  INTO v_resultado;

  -- (3) Dejar "por cobrar" — MISMA transacción. Si falla, se cae TODO (incl. la
  --     membresía y la exención). registrar_cargo_pendiente valida monto>0.
  IF p_dejar_pendiente THEN
    SELECT registrar_cargo_pendiente(p_usuario_id, p_cargo_monto_centavos, 'plan', p_cargo_descripcion)
    INTO v_cargo;
  END IF;

  SELECT id INTO v_mem_id
  FROM membresias WHERE usuario_id = p_usuario_id
  ORDER BY created_at DESC LIMIT 1;

  PERFORM _audrec_log(
    'membresia.alta', 'membresia', v_mem_id, p_usuario_id, v_socio_nombre,
    format('Asignó nuevo plan al socio. Motivo: %s', p_motivo),
    jsonb_build_object(
      'tier_id', p_tier_id, 'motivo', p_motivo, 'tipo', 'alta_inicial',
      'metodo_pago', p_metodo_pago, 'resultado', v_resultado,
      'cargo_pendiente', v_cargo
    )
  );

  v_resultado := v_resultado || jsonb_build_object('cargo_pendiente', v_cargo);
  IF v_owns THEN
    v_resultado := v_resultado || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_resultado);
  END IF;
  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_asignar_plan(uuid, uuid, text, text, integer, uuid, boolean, boolean, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION recepcion_asignar_plan(uuid, uuid, text, text, integer, uuid, boolean, boolean, integer, text) TO authenticated;

-- ── D4) recepcion_renovar_membresia (dueño de key; motor anidado sin key) ────
DROP FUNCTION IF EXISTS recepcion_renovar_membresia(uuid, text, text, integer);
CREATE OR REPLACE FUNCTION recepcion_renovar_membresia(
  p_usuario_id uuid,
  p_motivo text,
  p_metodo_pago text DEFAULT NULL,
  p_monto_centavos integer DEFAULT NULL,
  p_operation_key uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membresia_actual RECORD;
  v_socio_nombre text;
  v_resultado jsonb;
  v_tenant uuid := get_my_tenant_id();
  v_op jsonb;
  v_owns boolean := false;
BEGIN
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo obligatorio para renovar';
  END IF;

  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'membresia_renovar', get_my_user_id(),
      md5(jsonb_build_object('usuario', p_usuario_id, 'motivo', p_motivo,
                             'metodo', p_metodo_pago, 'monto', p_monto_centavos)::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  SELECT m.id, m.tier_id, m.status, u.nombre
  INTO v_membresia_actual
  FROM membresias m
  JOIN usuarios u ON u.id = m.usuario_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('activa', 'expirada', 'past_due', 'congelada')
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_membresia_actual.id IS NULL THEN
    RAISE EXCEPTION 'MEMBRESIA_NO_EXISTE: el usuario no tiene una membresía renovable';
  END IF;

  v_socio_nombre := v_membresia_actual.nombre;

  SELECT gestionar_membresia_socio(
    p_usuario_id, v_membresia_actual.tier_id, p_motivo, p_metodo_pago, p_monto_centavos
  ) INTO v_resultado;

  PERFORM _audrec_log(
    'membresia.renovar', 'membresia', v_membresia_actual.id, p_usuario_id, v_socio_nombre,
    format('Renovó membresía. Motivo: %s', p_motivo),
    jsonb_build_object(
      'tier_id', v_membresia_actual.tier_id, 'motivo', p_motivo,
      'metodo_pago', p_metodo_pago, 'resultado', v_resultado
    )
  );

  IF v_owns THEN
    v_resultado := v_resultado || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_resultado);
  END IF;
  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION recepcion_renovar_membresia(uuid, text, text, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION recepcion_renovar_membresia(uuid, text, text, integer, uuid) TO authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- SELF-TEST — DEVUELVE TABLA. Tenant desechable + admin/socio/producto simulados.
-- Cubre: same-key/same-payload, same-key/diff-payload=conflict, rollback no consume
-- key, POS retry, refund retry, renewal retry, cargo retry, membership retry,
-- AsignarPlan éxito, AsignarPlan fallo=todo-o-nada, NULL key legacy, aislamiento
-- de key por tenant.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _diag_wave1_idempotencia()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_tenant_b uuid;
  v_auth uuid := gen_random_uuid(); v_auth_b uuid := gen_random_uuid();
  v_admin uuid; v_admin_b uuid;
  v_socio uuid; v_socio2 uuid; v_socio3 uuid; v_socio_b uuid;
  v_tier uuid; v_tier_b uuid;
  v_prod uuid; v_prod_b uuid;
  v_slug text := 'zz-w1-' || substr(md5(random()::text), 1, 6);
  v_slug_b text := 'zz-w1b-' || substr(md5(random()::text), 1, 6);
  v_k uuid; v_r1 jsonb; v_r2 jsonb;
  v_pago uuid; v_cargo uuid;
  v_n int; v_conflict boolean; v_ok boolean;
BEGIN
  -- ── Tenant A ──
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug, 'W1 A', 'gym_libre', 'activo') RETURNING id INTO v_tenant;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_slug||'-a@sala.dev',
          jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'), '', now(), now(), now());
  UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth RETURNING id INTO v_admin;
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, tipo, clases_incluidas, duracion_dias, es_pase, inscripcion_centavos, activo, orden)
  VALUES (v_tenant, 'mensual', 'Mensual', 80000, 'MXN', 'mensual', 'tiempo', NULL, 30, false, 0, true, 1) RETURNING id INTO v_tier;
  INSERT INTO productos (tenant_id, nombre, precio_centavos, moneda, activo) VALUES (v_tenant, 'Agua', 2000, 'MXN', true) RETURNING id INTO v_prod;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-s@x.dev','S','miembro','activo') RETURNING id INTO v_socio;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-s2@x.dev','S2','miembro','activo') RETURNING id INTO v_socio2;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-s3@x.dev','S3','miembro','activo') RETURNING id INTO v_socio3;

  -- ── Tenant B (aislamiento) ──
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug_b, 'W1 B', 'gym_libre', 'activo') RETURNING id INTO v_tenant_b;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_slug_b||'-a@sala.dev',
          jsonb_build_object('tenant_slug', v_slug_b, 'nombre', 'Admin'), '', now(), now(), now());
  UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id=v_auth_b RETURNING id INTO v_admin_b;
  INSERT INTO productos (tenant_id, nombre, precio_centavos, moneda, activo) VALUES (v_tenant_b, 'Agua B', 2000, 'MXN', true) RETURNING id INTO v_prod_b;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant_b, v_slug_b||'-s@x.dev','SB','miembro','activo') RETURNING id INTO v_socio_b;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- 1) POS same-key/same-payload → 1 sola venta, 2ª already_processed.
  v_k := gen_random_uuid();
  v_r1 := vender_productos(NULL, 'efectivo', jsonb_build_array(jsonb_build_object('producto_id', v_prod, 'cantidad', 1)), NULL, v_k);
  v_r2 := vender_productos(NULL, 'efectivo', jsonb_build_array(jsonb_build_object('producto_id', v_prod, 'cantidad', 1)), NULL, v_k);
  SELECT count(*) INTO v_n FROM pagos WHERE tenant_id=v_tenant AND concepto='producto';
  prueba := '1. POS same-key → 1 venta y 2ª already_processed';
  resultado := CASE WHEN v_n=1 AND v_r2->>'status'='already_processed' AND (v_r1->>'pago_id')=(v_r2->>'pago_id')
    THEN '✅ 1 pago, converge' ELSE '❌ n='||v_n||' r2='||coalesce(v_r2->>'status','?') END; RETURN NEXT;

  -- 4) POS retry no duplica stock.
  SELECT count(*) INTO v_n FROM producto_movimientos WHERE tenant_id=v_tenant AND tipo='venta';
  prueba := '4. POS retry no duplica stock';
  resultado := CASE WHEN v_n=1 THEN '✅ 1 movimiento' ELSE '❌ movimientos='||v_n END; RETURN NEXT;

  -- 2) POS same-key/diff-payload → IDEMPOTENCY_CONFLICT.
  v_conflict := false;
  BEGIN
    PERFORM vender_productos(NULL, 'efectivo', jsonb_build_array(jsonb_build_object('producto_id', v_prod, 'cantidad', 5)), NULL, v_k);
  EXCEPTION WHEN raise_exception THEN
    v_conflict := SQLERRM LIKE 'IDEMPOTENCY_CONFLICT%';
  END;
  prueba := '2. same-key + payload distinto → IDEMPOTENCY_CONFLICT';
  resultado := CASE WHEN v_conflict THEN '✅ conflicto' ELSE '❌ no rechazó' END; RETURN NEXT;

  -- 12) misma key en tenant B NO colisiona (aislamiento por tenant).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_b::text)::text, true);
  v_ok := false;
  BEGIN
    v_r1 := vender_productos(NULL, 'efectivo', jsonb_build_array(jsonb_build_object('producto_id', v_prod_b, 'cantidad', 1)), NULL, v_k);
    v_ok := (v_r1->>'status')='ok';
  EXCEPTION WHEN raise_exception THEN v_ok := false;
  END;
  prueba := '12. misma operation_key en OTRO tenant no colisiona';
  resultado := CASE WHEN v_ok THEN '✅ ejecutó en tenant B' ELSE '❌ colisionó entre tenants' END; RETURN NEXT;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- 3) rollback no consume la key: 1er intento falla (socio inexistente) tras _op_begin,
  --    2º intento con la MISMA key y datos válidos debe reclamar y funcionar.
  v_k := gen_random_uuid();
  BEGIN
    PERFORM registrar_cargo_pendiente(gen_random_uuid(), 15000, 'plan', 'x', v_k);
  EXCEPTION WHEN raise_exception THEN NULL; -- SOCIO_NO_EXISTE esperado
  END;
  v_r1 := registrar_cargo_pendiente(v_socio, 15000, 'plan', 'Day pass', v_k);
  prueba := '3. rollback NO consume la key (reintento válido funciona)';
  resultado := CASE WHEN (v_r1->>'status')='ok' AND (v_r1->>'cargo_id') IS NOT NULL
    THEN '✅ reclamó tras el fallo' ELSE '❌ '||coalesce(v_r1->>'status','?') END; RETURN NEXT;

  -- 7) cargo retry → 1 solo cargo.
  v_r2 := registrar_cargo_pendiente(v_socio, 15000, 'plan', 'Day pass', v_k);
  SELECT count(*) INTO v_n FROM cargos_pendientes WHERE usuario_id=v_socio;
  prueba := '7. cargo pendiente retry → 1 solo cargo';
  resultado := CASE WHEN v_n=1 AND v_r2->>'status'='already_processed' THEN '✅ 1 cargo' ELSE '❌ cargos='||v_n END; RETURN NEXT;
  SELECT id INTO v_cargo FROM cargos_pendientes WHERE usuario_id=v_socio LIMIT 1;

  -- 8) membership (motor directo) retry → 1 sola membresía.
  v_k := gen_random_uuid();
  v_r1 := gestionar_membresia_socio(v_socio, v_tier, 'alta', 'efectivo', 80000, false, v_k);
  v_r2 := gestionar_membresia_socio(v_socio, v_tier, 'alta', 'efectivo', 80000, false, v_k);
  SELECT count(*) INTO v_n FROM pagos WHERE usuario_id=v_socio AND concepto='plan';
  prueba := '8. membership retry (motor) → 1 pago de plan';
  resultado := CASE WHEN v_n=1 AND v_r2->>'status'='already_processed' THEN '✅ 1 plan' ELSE '❌ planes='||v_n END; RETURN NEXT;

  -- 6) renewal retry → no doble-apila / 1 pago extra.
  v_k := gen_random_uuid();
  v_r1 := recepcion_renovar_membresia(v_socio, 'renueva', 'efectivo', 80000, v_k);
  v_r2 := recepcion_renovar_membresia(v_socio, 'renueva', 'efectivo', 80000, v_k);
  SELECT count(*) INTO v_n FROM pagos WHERE usuario_id=v_socio AND concepto='plan';
  prueba := '6. renewal retry → 1 solo cobro de renovación (total 2 planes)';
  resultado := CASE WHEN v_n=2 AND v_r2->>'status'='already_processed' THEN '✅ no doble-cobró' ELSE '❌ planes='||v_n END; RETURN NEXT;

  -- 5) refund retry → 1 solo reembolso.
  SELECT id INTO v_pago FROM pagos WHERE usuario_id=v_socio AND concepto='plan' ORDER BY created_at LIMIT 1;
  v_k := gen_random_uuid();
  v_r1 := registrar_reembolso(v_pago, 10000, 'error de cobro', v_k);
  v_r2 := registrar_reembolso(v_pago, 10000, 'error de cobro', v_k);
  SELECT count(*) INTO v_n FROM pagos WHERE concepto='reembolso' AND revierte_pago_id=v_pago;
  prueba := '5. refund retry → 1 solo reembolso';
  resultado := CASE WHEN v_n=1 AND v_r2->>'status'='already_processed' THEN '✅ 1 reembolso' ELSE '❌ reembolsos='||v_n END; RETURN NEXT;

  -- 9) AsignarPlan atómico éxito (socio2, con pendiente).
  v_k := gen_random_uuid();
  v_r1 := recepcion_asignar_plan(v_socio2, v_tier, 'alta', NULL, NULL, v_k, false, true, 80000, 'Mensual');
  SELECT count(*) INTO v_n FROM membresias WHERE usuario_id=v_socio2 AND status='activa';
  prueba := '9. AsignarPlan atómico éxito → membresía + cargo';
  resultado := CASE WHEN v_n=1 AND (v_r1->'cargo_pendiente'->>'cargo_id') IS NOT NULL AND v_r1->>'status'='ok'
    THEN '✅ membresía + por-cobrar' ELSE '❌ mem='||v_n END; RETURN NEXT;

  -- 10) AsignarPlan fallo (cargo monto=0) sobre socio LIMPIO → NADA se compromete:
  --     el motor crea la membresía, luego registrar_cargo_pendiente(0) lanza
  --     MONTO_INVALIDO → toda la transacción hace rollback → 0 membresías para socio3.
  v_ok := false;
  BEGIN
    PERFORM recepcion_asignar_plan(v_socio3, v_tier, 'alta', 'efectivo', 80000, gen_random_uuid(), true, true, 0, 'malo');
  EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'MONTO_INVALIDO%';
  END;
  SELECT count(*) INTO v_n FROM membresias WHERE usuario_id=v_socio3;
  prueba := '10. AsignarPlan con cargo inválido → rollback total (0 membresías socio3)';
  resultado := CASE WHEN v_ok AND v_n=0 THEN '✅ todo o nada' ELSE '❌ ok='||v_ok||' membresias='||v_n END; RETURN NEXT;

  -- 11) NULL key = comportamiento legacy (2 ventas distintas).
  PERFORM vender_productos(NULL, 'efectivo', jsonb_build_array(jsonb_build_object('producto_id', v_prod, 'cantidad', 1)), NULL, NULL);
  PERFORM vender_productos(NULL, 'efectivo', jsonb_build_array(jsonb_build_object('producto_id', v_prod, 'cantidad', 1)), NULL, NULL);
  SELECT count(*) INTO v_n FROM pagos WHERE tenant_id=v_tenant AND concepto='producto';
  prueba := '11. NULL key = legacy (2 llamadas sin key → 2 ventas)';
  resultado := CASE WHEN v_n=3 THEN '✅ sin dedup (1 con key + 2 sin key)' ELSE '❌ ventas='||v_n END; RETURN NEXT;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
  PERFORM cerrar_tenant(v_slug_b);
  RETURN;
END $$;

SELECT * FROM _diag_wave1_idempotencia();
DROP FUNCTION _diag_wave1_idempotencia();

-- Cierra la transacción atómica de la migración (todo lo de arriba commitea junto).
COMMIT;
