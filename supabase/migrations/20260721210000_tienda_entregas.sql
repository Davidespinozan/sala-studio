-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- TIENDA · compra del socio desde la app — datos (cola de entrega + registro)
-- ============================================================================
-- El socio compra desde su móvil, paga con su tarjeta guardada (Connect), y el
-- producto se le entrega en recepción, en la tienda, o se lo llevan (mesereo).
-- Esta migración es la base de datos de ese flujo:
--
--  · `tienda_entregas`: la cola de "pendientes de entregar". MUTABLE (a
--    diferencia de `pagos`, que es append-only): su estado va de pendiente a
--    entregado o cancelado. Por eso la entrega vive en su propia tabla.
--  · `registrar_venta_online`: la RPC que asienta la venta DESPUÉS de que
--    Stripe cobró. La llama la función de servidor (no el socio directo: nadie
--    registra su propia venta pagada). Idempotente por la referencia del cobro,
--    y BLOQUEA el oversell (no vende lo que no hay para entregar).
-- ============================================================================

CREATE TABLE IF NOT EXISTS tienda_entregas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- La venta que la generó (en la Caja).
  pago_id       uuid NOT NULL REFERENCES pagos(id) ON DELETE CASCADE,
  usuario_id    uuid REFERENCES usuarios(id) ON DELETE SET NULL,  -- el socio
  sucursal_id   uuid REFERENCES sucursales(id) ON DELETE SET NULL,

  tipo          text NOT NULL CHECK (tipo IN ('recepcion', 'tienda', 'llevar')),
  -- Dónde, si es 'llevar' (texto libre: "Cancha 3", "Sala de spinning").
  ubicacion     text,

  estado        text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'entregado', 'cancelado')),
  entregado_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  entregado_at  timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entregas_cola_idx ON tienda_entregas (tenant_id, estado, created_at);
-- Una venta = una entrega.
CREATE UNIQUE INDEX IF NOT EXISTS entregas_pago_unico ON tienda_entregas (pago_id);

DROP TRIGGER IF EXISTS entregas_set_updated_at ON tienda_entregas;
CREATE TRIGGER entregas_set_updated_at
  BEFORE UPDATE ON tienda_entregas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Seguridad ───────────────────────────────────────────────────────────────
ALTER TABLE tienda_entregas ENABLE ROW LEVEL SECURITY;

-- Staff: ve y gestiona la cola de su gym (marcar entregado).
DROP POLICY IF EXISTS entregas_staff ON tienda_entregas;
CREATE POLICY entregas_staff ON tienda_entregas
  FOR ALL TO authenticated
  USING (tenant_id = get_my_tenant_id() AND (is_admin() OR is_recepcionista()))
  WITH CHECK (tenant_id = get_my_tenant_id() AND (is_admin() OR is_recepcionista()));

-- El socio: ve SUS entregas (para saber si ya está lista), no las de otros.
DROP POLICY IF EXISTS entregas_socio_ve ON tienda_entregas;
CREATE POLICY entregas_socio_ve ON tienda_entregas
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND usuario_id = get_my_user_id());

-- ── RPC: registrar la venta online (la llama el servidor tras cobrar) ────────
CREATE OR REPLACE FUNCTION registrar_venta_online(
  p_tenant_id uuid,
  p_usuario_id uuid,
  p_sucursal_id uuid,
  p_items jsonb,              -- [{ producto_id, cantidad }]
  p_referencia text,         -- id del PaymentIntent (idempotencia)
  p_entrega_tipo text,
  p_entrega_ubicacion text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_prod productos;
  v_cant integer;
  v_stock integer;
  v_total integer := 0;
  v_moneda text := 'MXN';
  v_pago_id uuid;
  v_existente uuid;
BEGIN
  -- Idempotencia: si ya se registró esta referencia, devolver la existente (el
  -- webhook o un reintento no duplican la venta ni el descuento de stock).
  SELECT id INTO v_existente FROM pagos
  WHERE tenant_id = p_tenant_id AND referencia = p_referencia;
  IF v_existente IS NOT NULL THEN
    RETURN jsonb_build_object('pago_id', v_existente, 'idempotente', true);
  END IF;

  IF p_entrega_tipo NOT IN ('recepcion', 'tienda', 'llevar') THEN
    RAISE EXCEPTION 'ENTREGA_INVALIDA';
  END IF;
  IF jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'SIN_ITEMS';
  END IF;

  -- Validar cada producto, calcular total, y BLOQUEAR OVERSELL: la venta online
  -- no se lleva el producto en el momento, así que no se vende lo que no hay.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_prod FROM productos WHERE id = (v_item->>'producto_id')::uuid;
    IF v_prod.id IS NULL OR v_prod.tenant_id <> p_tenant_id OR v_prod.activo IS NOT TRUE THEN
      RAISE EXCEPTION 'PRODUCTO_INVALIDO';
    END IF;
    v_cant := COALESCE((v_item->>'cantidad')::integer, 0);
    IF v_cant <= 0 THEN RAISE EXCEPTION 'CANTIDAD_INVALIDA'; END IF;

    SELECT COALESCE(SUM(cantidad), 0) INTO v_stock FROM producto_movimientos
    WHERE producto_id = v_prod.id AND (p_sucursal_id IS NULL OR sucursal_id = p_sucursal_id);
    IF v_stock < v_cant THEN
      RAISE EXCEPTION 'SIN_STOCK: % (hay %, piden %)', v_prod.nombre, v_stock, v_cant;
    END IF;

    v_total := v_total + v_prod.precio_centavos * v_cant;
    v_moneda := v_prod.moneda;
  END LOOP;

  -- Asentar el cobro (Caja). cobrado_por NULL = cobro online, sin persona.
  INSERT INTO pagos (tenant_id, sucursal_id, usuario_id, concepto, monto_centavos, moneda, metodo, referencia, cobrado_por)
  VALUES (p_tenant_id, p_sucursal_id, p_usuario_id, 'producto', v_total, v_moneda, 'stripe', p_referencia, NULL)
  RETURNING id INTO v_pago_id;

  -- Descontar stock, atado a la venta.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO producto_movimientos (tenant_id, producto_id, sucursal_id, tipo, cantidad, pago_id)
    VALUES (p_tenant_id, (v_item->>'producto_id')::uuid, p_sucursal_id, 'venta', -((v_item->>'cantidad')::integer), v_pago_id);
  END LOOP;

  -- La entrega, en estado pendiente.
  INSERT INTO tienda_entregas (tenant_id, pago_id, usuario_id, sucursal_id, tipo, ubicacion)
  VALUES (p_tenant_id, v_pago_id, p_usuario_id, p_sucursal_id, p_entrega_tipo, p_entrega_ubicacion);

  RETURN jsonb_build_object('pago_id', v_pago_id, 'total_centavos', v_total, 'moneda', v_moneda);
END; $$;

-- ── RPC: marcar una entrega como entregada (staff) ──────────────────────────
CREATE OR REPLACE FUNCTION marcar_entregado(p_entrega_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller usuarios;
  v_entrega tienda_entregas;
BEGIN
  SELECT * INTO v_caller FROM usuarios WHERE auth_id = auth.uid();
  IF v_caller.id IS NULL OR v_caller.rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;
  SELECT * INTO v_entrega FROM tienda_entregas WHERE id = p_entrega_id;
  IF v_entrega.id IS NULL OR v_entrega.tenant_id <> v_caller.tenant_id THEN
    RAISE EXCEPTION 'ENTREGA_INVALIDA';
  END IF;
  IF v_entrega.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'YA_RESUELTA';
  END IF;
  UPDATE tienda_entregas
  SET estado = 'entregado', entregado_por = v_caller.id, entregado_at = now()
  WHERE id = p_entrega_id;
END; $$;

-- registrar_venta_online la llama SOLO el servidor (service_role): fuera de anon
-- y authenticated. marcar_entregado la llama el staff (valida rol adentro).
REVOKE ALL ON FUNCTION registrar_venta_online(uuid, uuid, uuid, jsonb, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION marcar_entregado(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION marcar_entregado(uuid) TO authenticated;

-- ============================================================================
-- TESTS — devuelven TABLA
-- ============================================================================
DROP TABLE IF EXISTS _res_entregas;

DO $$
DECLARE
  v_tenant uuid; v_suc uuid; v_socio uuid; v_prod uuid;
  v_r jsonb; v_pago uuid; v_ok boolean; v_n int;
BEGIN
  CREATE TEMP TABLE _res_entregas(n int, prueba text, resultado text) ON COMMIT PRESERVE ROWS;

  SELECT id INTO v_tenant FROM tenants LIMIT 1;
  SELECT id INTO v_suc FROM sucursales WHERE tenant_id = v_tenant LIMIT 1;
  SELECT id INTO v_socio FROM usuarios WHERE tenant_id = v_tenant AND rol = 'miembro' LIMIT 1;

  INSERT INTO productos (tenant_id, nombre, precio_centavos) VALUES (v_tenant, '_test_online', 5000) RETURNING id INTO v_prod;
  INSERT INTO producto_movimientos (tenant_id, producto_id, sucursal_id, tipo, cantidad) VALUES (v_tenant, v_prod, v_suc, 'entrada', 3);

  -- 1. Venta online: cobra, descuenta stock, crea entrega
  v_r := registrar_venta_online(v_tenant, v_socio, v_suc,
         jsonb_build_array(jsonb_build_object('producto_id', v_prod, 'cantidad', 2)),
         '_test_pi_1', 'llevar', 'Cancha 3');
  v_pago := (v_r->>'pago_id')::uuid;
  SELECT COALESCE(SUM(cantidad),0) INTO v_n FROM producto_movimientos WHERE producto_id = v_prod;
  INSERT INTO _res_entregas VALUES (1, 'Venta online descuenta stock (3-2=1)', CASE WHEN v_n = 1 THEN 'OK' ELSE 'FALLA: '||v_n END);

  -- 2. Se creó la entrega pendiente con el "dónde"
  SELECT (estado='pendiente' AND ubicacion='Cancha 3' AND tipo='llevar') INTO v_ok FROM tienda_entregas WHERE pago_id = v_pago;
  INSERT INTO _res_entregas VALUES (2, 'Entrega pendiente con ubicación', CASE WHEN v_ok THEN 'OK' ELSE 'FALLA' END);

  -- 3. Idempotencia: misma referencia no duplica
  v_r := registrar_venta_online(v_tenant, v_socio, v_suc,
         jsonb_build_array(jsonb_build_object('producto_id', v_prod, 'cantidad', 2)),
         '_test_pi_1', 'recepcion');
  INSERT INTO _res_entregas VALUES (3, 'Misma referencia NO duplica',
    CASE WHEN (v_r->>'idempotente')::boolean AND (v_r->>'pago_id')::uuid = v_pago THEN 'OK' ELSE 'FALLA' END);

  -- 4. Oversell bloqueado: queda 1, piden 5
  BEGIN
    v_r := registrar_venta_online(v_tenant, v_socio, v_suc,
           jsonb_build_array(jsonb_build_object('producto_id', v_prod, 'cantidad', 5)),
           '_test_pi_2', 'recepcion');
    INSERT INTO _res_entregas VALUES (4, 'Oversell bloqueado', 'FALLA: dejó vender sin stock');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _res_entregas VALUES (4, 'Oversell bloqueado', 'OK');
  END;

  -- Limpieza
  PERFORM set_config('sala.cierre_tenant', 'on', true);
  DELETE FROM tienda_entregas WHERE pago_id = v_pago;
  DELETE FROM producto_movimientos WHERE producto_id = v_prod;
  DELETE FROM pagos WHERE id = v_pago;
  DELETE FROM productos WHERE id = v_prod;
  PERFORM set_config('sala.cierre_tenant', 'off', true);
END $$;

SELECT n AS "#", prueba, resultado FROM _res_entregas ORDER BY n;