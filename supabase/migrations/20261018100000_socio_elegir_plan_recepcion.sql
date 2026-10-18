-- ============================================================================
-- SOCIO ELIGE SU PLAN Y LO PAGA EN RECEPCIÓN (desde la app)
-- ----------------------------------------------------------------------------
-- Pedido de The Core (18-oct-2026): la socia se registra sin tarjeta, entra a
-- la app (config.registro.acceso_sin_plan) y, al querer reservar, elige el
-- paquete y decide si lo paga con tarjeta (Stripe) o en recepción. Hasta hoy
-- la app solo ofrecía tarjeta.
--
-- "Pagar en recepción" NO crea membresía ni cargo: solo deja apuntado el plan
-- elegido en usuarios.membresia_tier (el mismo campo que ya llena el registro
-- y que la ficha de recepción muestra como "Plan elegido" para asignarlo y
-- cobrarlo en Caja). Reservar y check-in siguen bloqueados hasta que recepción
-- lo active con cobro. Sin dinero en juego acá.
-- ============================================================================

CREATE OR REPLACE FUNCTION socio_elegir_plan_recepcion(p_tier_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor  uuid;
  v_tenant uuid;
  v_tier   tiers%ROWTYPE;
BEGIN
  v_actor := get_my_user_id();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: usuario no autenticado';
  END IF;

  SELECT tenant_id INTO v_tenant FROM usuarios WHERE id = v_actor AND rol = 'miembro';
  IF v_tenant IS NULL OR v_tenant <> get_my_tenant_id() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo un socio puede elegir su plan';
  END IF;

  SELECT * INTO v_tier FROM tiers WHERE id = p_tier_id AND tenant_id = v_tenant;
  IF v_tier.id IS NULL OR v_tier.activo IS DISTINCT FROM true OR v_tier.en_venta IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PLAN_NO_DISPONIBLE: ese plan no está a la venta';
  END IF;

  -- Con membresía vigente no se "aparta" otro plan: eso es cambio/renovación,
  -- que ya tiene su propio flujo (con cobro).
  IF EXISTS (
    SELECT 1 FROM membresias
    WHERE usuario_id = v_actor
      AND status IN ('activa', 'trialing', 'past_due', 'congelada')
      AND (periodo_actual_fin IS NULL OR periodo_actual_fin > now())
  ) THEN
    RAISE EXCEPTION 'YA_TIENE_PLAN: ya tienes una membresía vigente';
  END IF;

  -- La clase de prueba es 1 por socio de por vida (misma regla que el checkout).
  IF v_tier.es_prueba IS TRUE AND EXISTS (SELECT 1 FROM pruebas_usadas WHERE usuario_id = v_actor) THEN
    RAISE EXCEPTION 'PRUEBA_YA_USADA: ya usaste tu clase de prueba';
  END IF;

  UPDATE usuarios SET membresia_tier = v_tier.slug WHERE id = v_actor;

  RETURN jsonb_build_object(
    'tier_id', v_tier.id,
    'tier_slug', v_tier.slug,
    'tier_nombre', v_tier.nombre,
    'precio_centavos', v_tier.precio_centavos
  );
END;
$$;

REVOKE ALL ON FUNCTION socio_elegir_plan_recepcion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION socio_elegir_plan_recepcion(uuid) TO authenticated;

-- Verificación (devuelve tabla; el editor esconde los NOTICE):
SELECT p.proname AS funcion,
       p.prosecdef AS security_definer,
       pg_get_function_identity_arguments(p.oid) AS args,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_puede,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_puede
FROM pg_proc p
WHERE p.proname = 'socio_elegir_plan_recepcion';
