-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- COBRAR LA MULTA EN RECEPCIÓN (Modelo A) — pieza 4 (RPC)
-- ────────────────────────────────────────────────────────────────────────────
-- El socio reservó asumiendo una multa (reservas.multa_centavos > 0). Cuando llega,
-- recepción la cobra: se registra el pago en la Caja (ledger `pagos`, concepto
-- 'otro') y la reserva queda con multa_pagada = true, ligada a ese pago.
--
-- Pago en MOSTRADOR (efectivo/tarjeta/transferencia). El cobro con tarjeta EN LÍNEA
-- al reservar se enchufará cuando prendamos venta-en-línea/Stripe (va al final).
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION cobrar_multa_reserva(
  p_reserva_id uuid,
  p_metodo text DEFAULT 'efectivo'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reserva reservas;
  v_sucursal uuid;
  v_pago_id uuid;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden cobrar multas';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;
  IF v_reserva.id IS NULL OR v_reserva.tenant_id <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: Esa reserva no es de este gimnasio';
  END IF;

  IF COALESCE(v_reserva.multa_centavos, 0) <= 0 THEN
    RAISE EXCEPTION 'SIN_MULTA: Esta reserva no tiene multa que cobrar';
  END IF;

  IF v_reserva.multa_pagada THEN
    RAISE EXCEPTION 'MULTA_YA_PAGADA: Esta multa ya se cobró';
  END IF;

  IF p_metodo NOT IN ('efectivo', 'tarjeta', 'transferencia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: Método de pago no válido';
  END IF;

  -- La sucursal del pago = la de la sala de la reserva (reservas no la guarda directo).
  SELECT sucursal_id INTO v_sucursal FROM recursos WHERE id = v_reserva.recurso_id;

  INSERT INTO pagos (
    tenant_id, sucursal_id, usuario_id,
    concepto, monto_centavos, moneda, metodo, referencia, notas, cobrado_por
  ) VALUES (
    v_reserva.tenant_id, v_sucursal, v_reserva.usuario_id,
    'otro', v_reserva.multa_centavos, 'MXN', p_metodo,
    v_reserva.folio,
    'Multa por reservar tras faltar (' || v_reserva.folio || ')',
    get_my_user_id()
  )
  RETURNING id INTO v_pago_id;

  UPDATE reservas
  SET multa_pagada = true, multa_pago_id = v_pago_id
  WHERE id = p_reserva_id;

  RETURN jsonb_build_object(
    'success', true,
    'pago_id', v_pago_id,
    'monto_centavos', v_reserva.multa_centavos
  );
END; $$;

REVOKE ALL ON FUNCTION cobrar_multa_reserva(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION cobrar_multa_reserva(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION cobrar_multa_reserva(uuid, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA: existe el RPC y authenticated puede ejecutarlo.
-- (El flujo funcional se prueba en recepción: is_recepcionista() necesita el JWT.)
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  'cobrar_multa_reserva' AS prueba,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname='cobrar_multa_reserva') AS rpc_ok,
  has_function_privilege('authenticated', 'cobrar_multa_reserva(uuid, text)', 'EXECUTE') AS grant_ok,
  NOT has_function_privilege('anon', 'cobrar_multa_reserva(uuid, text)', 'EXECUTE') AS anon_bloqueado;