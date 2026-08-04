-- ── Método de pago de la membresía (editable desde la ficha) ────────────────
--
-- Hoy el método vive solo en cada `pagos.metodo` (por transacción). No había un
-- "cómo paga este socio su membresía" persistente ni editable. Se agrega una
-- columna en `membresias` (informativa; NO mueve dinero) + una RPC chica y
-- gateada para que el staff la fije/cambie, sin tocar gestionar_membresia_socio.

ALTER TABLE membresias ADD COLUMN IF NOT EXISTS metodo_pago text;
ALTER TABLE membresias DROP CONSTRAINT IF EXISTS membresias_metodo_pago_check;
ALTER TABLE membresias ADD CONSTRAINT membresias_metodo_pago_check
  CHECK (metodo_pago IS NULL OR metodo_pago IN ('efectivo','tarjeta','transferencia','domiciliacion','otro'));

-- RPC: fija el método de pago de la membresía vigente del socio. Solo staff del
-- mismo gym. No cobra ni cambia el plan; solo actualiza el dato.
CREATE OR REPLACE FUNCTION establecer_metodo_pago(p_usuario_id uuid, p_metodo text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_tenant uuid;
  v_socio_tenant uuid;
  v_mem_id uuid;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo recepción o admin';
  END IF;
  v_actor_tenant := get_my_tenant_id();

  SELECT tenant_id INTO v_socio_tenant FROM usuarios WHERE id = p_usuario_id;
  IF v_socio_tenant IS NULL OR v_socio_tenant <> v_actor_tenant THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: el socio no es de tu gym';
  END IF;

  IF p_metodo IS NOT NULL
     AND p_metodo NOT IN ('efectivo','tarjeta','transferencia','domiciliacion','otro') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: método no válido (%)', p_metodo;
  END IF;

  -- La membresía más reciente del socio (activa/vigente o vencida).
  SELECT id INTO v_mem_id
  FROM membresias
  WHERE usuario_id = p_usuario_id
    AND status IN ('trialing','activa','past_due','congelada','expirada')
  ORDER BY created_at DESC
  LIMIT 1;
  IF v_mem_id IS NULL THEN
    RAISE EXCEPTION 'SIN_MEMBRESIA: el socio no tiene membresía';
  END IF;

  UPDATE membresias SET metodo_pago = p_metodo WHERE id = v_mem_id;

  RETURN jsonb_build_object('success', true, 'membresia_id', v_mem_id, 'metodo_pago', p_metodo);
END;
$$;

REVOKE ALL ON FUNCTION establecer_metodo_pago(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION establecer_metodo_pago(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION establecer_metodo_pago(uuid, text) TO authenticated;

-- ── Self-test (devuelve TABLA) ──────────────────────────────────────────────
SELECT 'columna membresias.metodo_pago existe' AS prueba,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'membresias' AND column_name = 'metodo_pago') AS pasa
UNION ALL
SELECT 'RPC establecer_metodo_pago existe',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'establecer_metodo_pago')
UNION ALL
SELECT 'authenticated puede ejecutar la RPC',
       has_function_privilege('authenticated', 'establecer_metodo_pago(uuid, text)', 'EXECUTE')
UNION ALL
SELECT 'anon NO puede ejecutar la RPC',
       NOT has_function_privilege('anon', 'establecer_metodo_pago(uuid, text)', 'EXECUTE');