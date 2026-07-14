-- ============================================================================
-- El gym podía regalarse el SaaS desde el navegador
-- ----------------------------------------------------------------------------
-- La RLS de suscripciones_saas era FOR ALL para el admin del tenant. O sea que
-- el dueño de un gym (o cualquiera con su sesión abierta) podía hacer un PATCH
-- directo a la API y ponerse:
--
--     estado = 'activa', precio_centavos = 0, periodo_actual_termina = '2099-01-01'
--
-- SaaS gratis de por vida, sin tocar Stripe. Y sin malicia también dolía: el
-- mock del frontend hacía upsert con estado 'trial', así que cada vez que el
-- admin "cambiaba de plan" se reiniciaba el trial de 7 días.
--
-- Esta tabla es el ESTADO DE COBRO de SALA, no un dato del gym: la escribe
-- Stripe (vía webhook, con service_role, que ignora RLS). El gym solo la lee.
--
-- Única excepción: el tenant DEMO, donde el pago es simulado a propósito. Para
-- ese caso queda una RPC que valida el slug del demo del lado del servidor —
-- no una puerta abierta en la tabla.
-- ============================================================================

-- ── 1) El gym LEE su suscripción. No la escribe. ────────────────────────────
DROP POLICY IF EXISTS suscripciones_saas_admin_all ON suscripciones_saas;
DROP POLICY IF EXISTS suscripciones_saas_admin_select ON suscripciones_saas;

CREATE POLICY suscripciones_saas_admin_select ON suscripciones_saas
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin());

COMMENT ON TABLE suscripciones_saas IS
  'Suscripción de un tenant (gym) al SaaS SALA. Una fila por tenant. La ESCRIBE '
  'el webhook de Stripe con service_role; el admin del gym solo tiene SELECT. '
  'El tenant demo escribe vía demo_suscripcion_mock() / demo_suscripcion_cancelar().';


-- ── 2) El demo sigue pudiendo simular su pago ───────────────────────────────
-- El demo es una sandbox pública: ahí el "checkout" es de mentira a propósito.
-- La RPC deja hacerlo SOLO si el tenant es el demo y quien llama es su admin.
-- Cualquier otro gym que la invoque se lleva un error.
CREATE OR REPLACE FUNCTION demo_suscripcion_mock(
  p_tier text,
  p_moneda text,
  p_precio_centavos integer,
  p_trial_dias integer DEFAULT 7
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := get_my_tenant_id();
  v_slug text;
  v_fin_trial timestamptz := now() + (p_trial_dias || ' days')::interval;
BEGIN
  IF v_tenant_id IS NULL OR NOT is_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo el admin del tenant';
  END IF;

  SELECT slug INTO v_slug FROM tenants WHERE id = v_tenant_id;

  IF v_slug IS DISTINCT FROM 'healthyspace' THEN
    RAISE EXCEPTION 'SOLO_DEMO: El pago simulado existe solo en el tenant demo. '
                    'Un gym real se suscribe por Stripe.';
  END IF;

  INSERT INTO suscripciones_saas (
    tenant_id, tier, moneda, estado, trial_termina, periodo_actual_termina,
    precio_centavos, stripe_customer_id, stripe_subscription_id, cancelada_at
  )
  VALUES (
    v_tenant_id, p_tier, p_moneda, 'trial', v_fin_trial, v_fin_trial,
    p_precio_centavos,
    'mock_cus_' || substr(md5(random()::text), 1, 10),
    'mock_sub_' || substr(md5(random()::text), 1, 10),
    NULL
  )
  ON CONFLICT (tenant_id) DO UPDATE SET
    tier = EXCLUDED.tier,
    moneda = EXCLUDED.moneda,
    estado = 'trial',
    trial_termina = EXCLUDED.trial_termina,
    periodo_actual_termina = EXCLUDED.periodo_actual_termina,
    precio_centavos = EXCLUDED.precio_centavos,
    cancelada_at = NULL;
END;
$$;

CREATE OR REPLACE FUNCTION demo_suscripcion_cancelar()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := get_my_tenant_id();
  v_slug text;
BEGIN
  IF v_tenant_id IS NULL OR NOT is_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo el admin del tenant';
  END IF;

  SELECT slug INTO v_slug FROM tenants WHERE id = v_tenant_id;

  IF v_slug IS DISTINCT FROM 'healthyspace' THEN
    RAISE EXCEPTION 'SOLO_DEMO: Un gym real cancela por Stripe.';
  END IF;

  UPDATE suscripciones_saas
  SET estado = 'cancelada', cancelada_at = now()
  WHERE tenant_id = v_tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION demo_suscripcion_mock(text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION demo_suscripcion_mock(text, text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION demo_suscripcion_mock(text, text, integer, integer) TO authenticated;

REVOKE ALL ON FUNCTION demo_suscripcion_cancelar() FROM PUBLIC;
REVOKE ALL ON FUNCTION demo_suscripcion_cancelar() FROM anon;
GRANT EXECUTE ON FUNCTION demo_suscripcion_cancelar() TO authenticated;


-- ============================================================================
-- SELF-TEST
-- ============================================================================
SELECT
  'la única policy de escritura murió' AS prueba,
  'sin policies INSERT/UPDATE/DELETE' AS espera,
  CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FALLA: ' || string_agg(policyname, ', ') END AS resultado
FROM pg_policies
WHERE tablename = 'suscripciones_saas'
  AND cmd <> 'SELECT'

UNION ALL

SELECT
  'el admin conserva la lectura',
  '1 policy SELECT',
  CASE WHEN count(*) = 1 THEN 'OK' ELSE 'FALLA: ' || count(*)::text END
FROM pg_policies
WHERE tablename = 'suscripciones_saas'
  AND cmd = 'SELECT'

UNION ALL

SELECT
  'las RPCs del demo existen',
  '2 funciones',
  CASE WHEN count(*) = 2 THEN 'OK' ELSE 'FALLA: ' || count(*)::text END
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('demo_suscripcion_mock', 'demo_suscripcion_cancelar');
