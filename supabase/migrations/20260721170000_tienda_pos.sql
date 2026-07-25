-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- TIENDA (POS + inventario) — modelo de datos
-- ============================================================================
-- El complemento Tienda: el gym vende productos (agua, proteína, ropa) desde
-- recepción o desde una estación aparte. Este es el modelo de datos; la venta
-- ENTRA A LA CAJA QUE YA EXISTE (`pagos`), no a un sistema paralelo — si no, el
-- gym queda con dos verdades sobre su dinero y ningún corte cuadra.
--
-- DECISIONES (ya tomadas con David):
--  · Catálogo COMPARTIDO entre sucursales (el mismo producto y precio en todas).
--  · Stock POR SUCURSAL, con un LEDGER append-only (entrada/venta/ajuste/merma).
--    El stock es la SUMA de los movimientos, nunca un campo editable que se
--    desincroniza — misma filosofía que `pagos` y `movimientos_dinero`.
--  · El stock se descuenta AL PAGAR (dentro de la venta), no al entregar.
--  · Se le vende a un socio O a alguien de la calle: por eso `pagos.usuario_id`
--    pasa a poder ir NULL para conceptos que no son de membresía.
-- ============================================================================

-- ── 1. Catálogo de productos (compartido entre sucursales) ──────────────────
CREATE TABLE IF NOT EXISTS productos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre         text NOT NULL,
  categoria      text,
  precio_centavos integer NOT NULL CHECK (precio_centavos >= 0),
  moneda         text NOT NULL DEFAULT 'MXN',
  foto_url       text,
  -- Se DESACTIVA, no se borra: sus ventas históricas siguen en la Caja y no
  -- deben quedar apuntando a un producto que ya no existe.
  activo         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS productos_tenant_idx ON productos (tenant_id) WHERE activo;

DROP TRIGGER IF EXISTS productos_set_updated_at ON productos;
CREATE TRIGGER productos_set_updated_at
  BEFORE UPDATE ON productos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 2. Ledger de stock (append-only, por sucursal) ──────────────────────────
CREATE TABLE IF NOT EXISTS producto_movimientos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  producto_id  uuid NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  sucursal_id  uuid REFERENCES sucursales(id) ON DELETE SET NULL,

  tipo         text NOT NULL CHECK (tipo IN ('entrada', 'venta', 'ajuste', 'merma', 'devolucion')),
  -- Con signo: entrada/devolución +, venta/merma −, ajuste cualquiera. El stock
  -- es SUM(cantidad). Nunca cero: un movimiento que no mueve nada no existe.
  cantidad     integer NOT NULL CHECK (cantidad <> 0),
  motivo       text,
  -- La venta que lo generó (si tipo='venta'). Ata el descuento de stock al cobro.
  pago_id      uuid REFERENCES pagos(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prod_mov_stock_idx ON producto_movimientos (producto_id, sucursal_id);
CREATE INDEX IF NOT EXISTS prod_mov_tenant_fecha_idx ON producto_movimientos (tenant_id, created_at DESC);

-- Append-only: un movimiento equivocado se corrige con OTRO movimiento, no se
-- edita ni se borra. Mismo candado que `pagos`. Escape hatch para cerrar tenant.
CREATE OR REPLACE FUNCTION trg_producto_mov_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('sala.cierre_tenant', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'STOCK_APPEND_ONLY: un movimiento de stock no se edita ni se borra; registrá un ajuste';
END; $$;

DROP TRIGGER IF EXISTS producto_mov_no_update ON producto_movimientos;
CREATE TRIGGER producto_mov_no_update
  BEFORE UPDATE OR DELETE ON producto_movimientos
  FOR EACH ROW EXECUTE FUNCTION trg_producto_mov_append_only();

-- ── 3. Stock actual = suma del ledger, por producto y sucursal ──────────────
CREATE OR REPLACE VIEW producto_stock AS
SELECT tenant_id, producto_id, sucursal_id, SUM(cantidad)::integer AS stock
FROM producto_movimientos
GROUP BY tenant_id, producto_id, sucursal_id;

-- ── 4. La Caja acepta ventas de producto ────────────────────────────────────
-- `pagos` es la Caja. Para que la venta aparezca en el corte y los reportes,
-- se registra ahí con concepto 'producto'. Y como se le vende a la calle, el
-- socio deja de ser obligatorio para ese concepto (y para 'otro').
-- Ojo: `pagos` puede tener el CHECK de concepto con distintos nombres según por
-- qué migración pasó (el inline `pagos_concepto_check` y el `pagos_concepto_valido`
-- de reembolsos). Se dropean AMBOS y se deja uno solo, con 'producto'.
ALTER TABLE pagos DROP CONSTRAINT IF EXISTS pagos_concepto_check;
ALTER TABLE pagos DROP CONSTRAINT IF EXISTS pagos_concepto_valido;
ALTER TABLE pagos ADD CONSTRAINT pagos_concepto_valido
  CHECK (concepto IN ('plan', 'inscripcion', 'paquete', 'otro', 'reembolso', 'producto'));

ALTER TABLE pagos ALTER COLUMN usuario_id DROP NOT NULL;
ALTER TABLE pagos DROP CONSTRAINT IF EXISTS pagos_usuario_requerido;
ALTER TABLE pagos ADD CONSTRAINT pagos_usuario_requerido
  -- La membresía SIEMPRE es de un socio; un producto o un 'otro' pueden no serlo.
  CHECK (usuario_id IS NOT NULL OR concepto IN ('producto', 'otro'));

-- ── 5. Seguridad ────────────────────────────────────────────────────────────
ALTER TABLE productos ENABLE ROW LEVEL SECURITY;
ALTER TABLE producto_movimientos ENABLE ROW LEVEL SECURITY;

-- Catálogo: lo VE cualquier staff del gym (para vender). Lo EDITA solo el admin.
DROP POLICY IF EXISTS productos_ve_staff ON productos;
CREATE POLICY productos_ve_staff ON productos
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND (is_admin() OR is_recepcionista()));

DROP POLICY IF EXISTS productos_edita_admin ON productos;
CREATE POLICY productos_edita_admin ON productos
  FOR ALL TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

-- Ledger de stock: lo VE el staff; lo ESCRIBE solo por RPC (SECURITY DEFINER),
-- que valida rol y ata la venta al cobro. No hay policy de INSERT directo.
DROP POLICY IF EXISTS prod_mov_ve_staff ON producto_movimientos;
CREATE POLICY prod_mov_ve_staff ON producto_movimientos
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND (is_admin() OR is_recepcionista()));

-- ── 6. RPC: vender productos ────────────────────────────────────────────────
-- Una venta = un renglón en la Caja (pagos, concepto 'producto') + un descuento
-- de stock por cada ítem, atómico. El precio se snapshotea del producto en el
-- momento (un cambio de precio futuro no reescribe ventas viejas).
CREATE OR REPLACE FUNCTION vender_productos(
  p_sucursal_id uuid,
  p_metodo text,
  p_items jsonb,               -- [{ producto_id, cantidad }]
  p_usuario_id uuid DEFAULT NULL  -- socio, si aplica; NULL = venta a la calle
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
BEGIN
  -- Quién cobra: staff del gym (recepción o admin).
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

  -- Primer paso: validar cada producto y calcular el total. Todo o nada.
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

  -- El cobro entra a la Caja.
  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id, concepto, monto_centavos, moneda, metodo, cobrado_por
  ) VALUES (
    v_caller.tenant_id, p_sucursal_id, p_usuario_id, 'producto', v_total, v_moneda, p_metodo, v_caller.id
  )
  RETURNING id INTO v_pago_id;

  -- El stock se descuenta, atado a esa venta. Se PERMITE quedar en negativo (no
  -- se frena una venta real porque el conteo esté mal); el negativo se ve como
  -- alerta en la vista de stock.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO producto_movimientos (
      tenant_id, producto_id, sucursal_id, tipo, cantidad, pago_id, created_by
    ) VALUES (
      v_caller.tenant_id, (v_item->>'producto_id')::uuid, p_sucursal_id,
      'venta', -((v_item->>'cantidad')::integer), v_pago_id, v_caller.id
    );
  END LOOP;

  RETURN jsonb_build_object('pago_id', v_pago_id, 'total_centavos', v_total, 'moneda', v_moneda);
END; $$;

-- ── 7. RPC: ajustar stock (entrada, ajuste, merma) — solo admin ─────────────
CREATE OR REPLACE FUNCTION ajustar_stock(
  p_producto_id uuid,
  p_sucursal_id uuid,
  p_cantidad integer,   -- con signo
  p_tipo text,          -- 'entrada' | 'ajuste' | 'merma' | 'devolucion'
  p_motivo text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller usuarios;
  v_prod productos;
  v_id uuid;
BEGIN
  SELECT * INTO v_caller FROM usuarios WHERE auth_id = auth.uid();
  IF v_caller.id IS NULL OR v_caller.rol <> 'admin' THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo el admin ajusta stock';
  END IF;
  IF p_tipo NOT IN ('entrada', 'ajuste', 'merma', 'devolucion') THEN
    RAISE EXCEPTION 'TIPO_INVALIDO';
  END IF;
  IF p_cantidad = 0 THEN
    RAISE EXCEPTION 'CANTIDAD_CERO';
  END IF;

  SELECT * INTO v_prod FROM productos WHERE id = p_producto_id;
  IF v_prod.id IS NULL OR v_prod.tenant_id <> v_caller.tenant_id THEN
    RAISE EXCEPTION 'PRODUCTO_INVALIDO';
  END IF;

  INSERT INTO producto_movimientos (
    tenant_id, producto_id, sucursal_id, tipo, cantidad, motivo, created_by
  ) VALUES (
    v_caller.tenant_id, p_producto_id, p_sucursal_id, p_tipo, p_cantidad, p_motivo, v_caller.id
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END; $$;

-- Las RPC las llama el staff (authenticated); validan rol adentro. anon fuera.
REVOKE ALL ON FUNCTION vender_productos(uuid, text, jsonb, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION ajustar_stock(uuid, uuid, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vender_productos(uuid, text, jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION ajustar_stock(uuid, uuid, integer, text, text) TO authenticated;

-- ============================================================================
-- TESTS — devuelven TABLA (el editor esconde los NOTICE)
-- ============================================================================
DROP TABLE IF EXISTS _res_tienda;

DO $$
DECLARE
  v_tenant uuid;
  v_prod uuid;
  v_suc uuid;
  v_stock integer;
  v_pago uuid;
  v_ok boolean;
BEGIN
  CREATE TEMP TABLE _res_tienda(n int, prueba text, resultado text) ON COMMIT PRESERVE ROWS;

  SELECT id INTO v_tenant FROM tenants LIMIT 1;
  SELECT id INTO v_suc FROM sucursales WHERE tenant_id = v_tenant LIMIT 1;

  -- 1. Crear un producto
  INSERT INTO productos (tenant_id, nombre, precio_centavos) VALUES (v_tenant, '_test_proteina', 15000)
  RETURNING id INTO v_prod;
  INSERT INTO _res_tienda VALUES (1, 'Crear un producto', 'OK');

  -- 2. Cargar stock (entrada) y que la vista lo sume
  INSERT INTO producto_movimientos (tenant_id, producto_id, sucursal_id, tipo, cantidad)
  VALUES (v_tenant, v_prod, v_suc, 'entrada', 10);
  SELECT stock INTO v_stock FROM producto_stock WHERE producto_id = v_prod;
  INSERT INTO _res_tienda VALUES (2, 'Entrada de 10 → stock 10',
    CASE WHEN v_stock = 10 THEN 'OK' ELSE 'FALLA: ' || COALESCE(v_stock::text, 'null') END);

  -- 3. Un movimiento de stock no se puede editar
  BEGIN
    UPDATE producto_movimientos SET cantidad = 999 WHERE producto_id = v_prod;
    INSERT INTO _res_tienda VALUES (3, 'No se puede editar un movimiento', 'FALLA: dejó editar');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _res_tienda VALUES (3, 'No se puede editar un movimiento', 'OK');
  END;

  -- 4. Una venta a la calle entra a la Caja SIN socio
  INSERT INTO pagos (tenant_id, sucursal_id, usuario_id, concepto, monto_centavos, metodo)
  VALUES (v_tenant, v_suc, NULL, 'producto', 15000, 'efectivo')
  RETURNING id INTO v_pago;
  INSERT INTO producto_movimientos (tenant_id, producto_id, sucursal_id, tipo, cantidad, pago_id)
  VALUES (v_tenant, v_prod, v_suc, 'venta', -1, v_pago);
  SELECT stock INTO v_stock FROM producto_stock WHERE producto_id = v_prod;
  INSERT INTO _res_tienda VALUES (4, 'Venta a la calle (sin socio) → stock 9',
    CASE WHEN v_stock = 9 THEN 'OK' ELSE 'FALLA: ' || COALESCE(v_stock::text, 'null') END);

  -- 5. Pero un PLAN sin socio sigue prohibido (la membresía es de alguien)
  BEGIN
    INSERT INTO pagos (tenant_id, usuario_id, concepto, monto_centavos, metodo)
    VALUES (v_tenant, NULL, 'plan', 100, 'efectivo');
    INSERT INTO _res_tienda VALUES (5, 'Un PLAN sin socio se rechaza', 'FALLA: lo aceptó');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _res_tienda VALUES (5, 'Un PLAN sin socio se rechaza', 'OK');
  END;

  -- 6. Un movimiento de cantidad 0 se rechaza
  BEGIN
    INSERT INTO producto_movimientos (tenant_id, producto_id, sucursal_id, tipo, cantidad)
    VALUES (v_tenant, v_prod, v_suc, 'ajuste', 0);
    INSERT INTO _res_tienda VALUES (6, 'Un movimiento de 0 se rechaza', 'FALLA: lo aceptó');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _res_tienda VALUES (6, 'Un movimiento de 0 se rechaza', 'OK');
  END;

  -- Limpieza (con el escape hatch del cierre de tenant)
  PERFORM set_config('sala.cierre_tenant', 'on', true);
  DELETE FROM producto_movimientos WHERE producto_id = v_prod;
  DELETE FROM pagos WHERE id = v_pago;
  DELETE FROM productos WHERE id = v_prod;
  PERFORM set_config('sala.cierre_tenant', 'off', true);
END $$;

SELECT n AS "#", prueba, resultado FROM _res_tienda ORDER BY n;