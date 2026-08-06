-- ============================================================================
-- Cancelar una venta de la Tienda (deshacer): devuelve stock + reversa dinero
-- ============================================================================
-- Hasta hoy no había forma, desde la app, de deshacer una venta de producto mal
-- hecha: el reembolso existía pero (a) no estaba en ningún botón y (b) no devolvía
-- el stock. Esta RPC hace las dos cosas, atómicas:
--   1) Reversa el dinero con el flujo de reembolso existente (valida que no esté
--      ya cancelada; si lo está, corta ahí y no toca el stock).
--   2) Devuelve el stock con un movimiento 'devolucion' (+) por cada línea vendida.
-- Append-only intacto: no se edita/borra nada, se COMPENSA con movimientos nuevos.
-- ============================================================================

CREATE OR REPLACE FUNCTION cancelar_venta_producto(p_pago_id uuid, p_motivo text)
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

  -- 1) Dinero primero: registrar_reembolso valida que quede algo por devolver. Si
  --    ya se canceló (YA_REEMBOLSADO), aborta acá y el stock no se toca dos veces.
  v_reembolso := registrar_reembolso(p_pago_id, NULL, p_motivo);

  -- 2) Stock: una 'devolucion' (+) por cada movimiento de venta de este cobro.
  FOR v_mov IN
    SELECT producto_id, sucursal_id, cantidad
    FROM producto_movimientos
    WHERE pago_id = p_pago_id AND tipo = 'venta'
  LOOP
    INSERT INTO producto_movimientos (tenant_id, producto_id, sucursal_id, tipo, cantidad, motivo, created_by)
    VALUES (
      v_tenant, v_mov.producto_id, v_mov.sucursal_id, 'devolucion',
      -v_mov.cantidad,  -- la venta fue negativa; la devolución la revierte (+)
      'Cancelación de venta: ' || trim(p_motivo), get_my_user_id()
    );
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'reembolso', v_reembolso);
END;
$$;

REVOKE ALL ON FUNCTION cancelar_venta_producto(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancelar_venta_producto(uuid, text) TO authenticated;

COMMENT ON FUNCTION cancelar_venta_producto(uuid, text) IS
  'Deshace una venta de la Tienda: reversa el dinero (registrar_reembolso) y devuelve el stock (movimientos devolucion). Solo staff. Idempotente vía el candado de reembolso.';

-- ── Verificación (devuelve tabla) ────────────────────────────────────────────
SELECT
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'cancelar_venta_producto') AS rpc_creada,
  has_function_privilege('authenticated', 'cancelar_venta_producto(uuid, text)', 'EXECUTE') AS ejecuta_staff;
