-- ============================================================================
-- Liberar subdominios de altas ABANDONADAS.
-- ----------------------------------------------------------------------------
-- PROBLEMA: el slug se reserva al crear el tenant, ANTES de pagar (el modelo es
-- 7 días de prueba, no se cobra por adelantado). Pero nadie limpiaba las altas
-- que nunca completaban: si alguien elegía "yogasol" y abandonaba en el pago,
-- ese subdominio quedaba muerto PARA SIEMPRE. Sin expiración ni forma de
-- reclamarlo. En producción los nombres buenos se van quemando solos.
--
-- LA SEÑAL NO ES "PAGÓ": un gym en prueba legítimo tampoco pagó todavía (Stripe
-- cobra $0 durante el trial). La señal es si LLEGÓ A STRIPE, o sea si hay una
-- suscripción real con tarjeta capturada (`stripe_subscription_id`).
--
-- CUÁNDO se considera abandonado (las 3 condiciones, juntas):
--   1. `stripe_subscription_id IS NULL` → nunca llegó al checkout de Stripe.
--   2. Su trial venció hace más de DIAS_GRACIA_SLUG días.
--   3. No es el tenant demo.
--
-- POR QUÉ ESPERAR A QUE VENZA EL TRIAL (y no unas horas): un gym puede completar
-- el alta, saltarse el pago y usar el sistema legítimamente durante sus 7 días
-- de prueba sin tarjeta. Liberarle el slug mientras lo está usando sería
-- romperle el negocio. Recién cuando pasó el trial + la gracia (el paywall ya lo
-- bloqueó) y encima nunca puso tarjeta, es un alta muerta.
--
-- POR QUÉ SOLO `IS NULL` Y NO `mock_%`: los `mock_sub_*` son del checkout mock
-- viejo. Ahí viven el tenant DEMO y gyms REALES pre-Stripe (ej. numawellness).
-- Barrerlos le liberaría el subdominio a un cliente real. Quedan intactos.
-- ============================================================================

-- 15 días DESPUÉS de vencido el trial. Con trial 7d + gracia 5d, el panel ya
-- está bloqueado al día 12: 15 es generoso con el que vuelve a pagar, y libera
-- el nombre cuando de verdad está muerto.
CREATE OR REPLACE FUNCTION dias_gracia_slug()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 15 $$;

-- ── Predicado: ¿este tenant es un alta abandonada? ──────────────────────────
CREATE OR REPLACE FUNCTION tenant_abandonado(p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM suscripciones_saas s
    JOIN tenants t ON t.id = s.tenant_id
    WHERE s.tenant_id = p_tenant_id
      AND s.stripe_subscription_id IS NULL          -- nunca llegó a Stripe
      AND s.trial_termina IS NOT NULL
      AND s.trial_termina < now() - (dias_gracia_slug() || ' days')::interval
      AND t.slug <> 'healthyspace'                  -- el demo nunca se libera
  );
$$;

COMMENT ON FUNCTION tenant_abandonado(uuid) IS
  'true si el tenant nunca llegó a Stripe (sin stripe_subscription_id) y su trial venció hace más de dias_gracia_slug(). Excluye el demo. Ver 20260718120000.';

-- ── slug_disponible: un slug tomado por un alta abandonada cuenta como LIBRE ──
CREATE OR REPLACE FUNCTION slug_disponible(p_slug text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM tenants t
    WHERE t.slug = lower(trim(p_slug))
      AND NOT tenant_abandonado(t.id)
  );
$$;

REVOKE ALL ON FUNCTION slug_disponible(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION slug_disponible(text) TO anon, authenticated;

COMMENT ON FUNCTION slug_disponible(text) IS
  'Onboarding: true si ningún tenant VIVO usa ese slug. Los tenants abandonados (nunca llegaron a Stripe + trial vencido) no lo bloquean. SECURITY DEFINER: la RLS solo expone activos a anon.';

-- ── Liberar: renombra el slug del alta abandonada para dejarlo disponible ────
-- NO borra nada: los datos y los pagos (append-only) quedan intactos; solo se
-- le corre el slug al tenant muerto. Idempotente y seguro de reintentar.
CREATE OR REPLACE FUNCTION liberar_slug_abandonado(p_slug text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_slug text := lower(trim(p_slug));
BEGIN
  SELECT t.id INTO v_id
  FROM tenants t
  WHERE t.slug = v_slug AND tenant_abandonado(t.id)
  LIMIT 1;

  IF v_id IS NULL THEN
    RETURN false;                                    -- libre, o vivo: no se toca
  END IF;

  UPDATE tenants
  SET slug = v_slug || '-abandonado-' || substr(id::text, 1, 8)
  WHERE id = v_id;

  RETURN true;
END $$;

-- Solo el backend (service_role). Supabase concede EXECUTE a authenticated por
-- default → hay que revocar de PUBLIC, authenticated Y anon.
REVOKE ALL ON FUNCTION liberar_slug_abandonado(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION liberar_slug_abandonado(text) FROM authenticated;
REVOKE ALL ON FUNCTION liberar_slug_abandonado(text) FROM anon;

COMMENT ON FUNCTION liberar_slug_abandonado(text) IS
  'Onboarding (service_role): si el slug lo tiene un alta abandonada, le renombra el slug a <slug>-abandonado-<id8> y devuelve true. No borra datos.';

-- ============================================================================
-- TEST — devuelve TABLA (el editor esconde los NOTICE).
-- Crea un tenant abandonado de mentira, verifica las 3 reglas, y limpia.
-- ============================================================================
DROP TABLE IF EXISTS _res;
DO $$
DECLARE
  v_slug   text := 'zz-test-abandonado-' || substr(md5(random()::text), 1, 6);
  v_tid    uuid;
  v_vivo   uuid;
  v_slugv  text := 'zz-test-vivo-' || substr(md5(random()::text), 1, 6);
  v_lib_ab boolean;
  v_lib_vi boolean;
BEGIN
  CREATE TEMP TABLE _res(caso text, esperado text, obtenido text, ok boolean) ON COMMIT PRESERVE ROWS;

  -- (A) Tenant ABANDONADO: sin stripe_subscription_id + trial vencido hace mucho.
  INSERT INTO tenants (slug, nombre) VALUES (v_slug, 'Test abandonado') RETURNING id INTO v_tid;
  INSERT INTO suscripciones_saas (tenant_id, tier, moneda, estado, trial_termina, precio_centavos, stripe_subscription_id)
  VALUES (v_tid, 'starter', 'mxn', 'trial', now() - ((dias_gracia_slug() + 5) || ' days')::interval, 190000, NULL);

  -- (B) Tenant VIVO: mismo caso pero con suscripción real en Stripe.
  INSERT INTO tenants (slug, nombre) VALUES (v_slugv, 'Test vivo') RETURNING id INTO v_vivo;
  INSERT INTO suscripciones_saas (tenant_id, tier, moneda, estado, trial_termina, precio_centavos, stripe_subscription_id)
  VALUES (v_vivo, 'starter', 'mxn', 'trial', now() - ((dias_gracia_slug() + 5) || ' days')::interval, 190000, 'sub_de_verdad');

  INSERT INTO _res VALUES ('1 abandonado se detecta', 'true', tenant_abandonado(v_tid)::text, tenant_abandonado(v_tid) = true);
  INSERT INTO _res VALUES ('2 su slug figura LIBRE', 'true', slug_disponible(v_slug)::text, slug_disponible(v_slug) = true);
  INSERT INTO _res VALUES ('3 el que SI pago no se toca', 'false', tenant_abandonado(v_vivo)::text, tenant_abandonado(v_vivo) = false);
  INSERT INTO _res VALUES ('4 su slug sigue TOMADO', 'false', slug_disponible(v_slugv)::text, slug_disponible(v_slugv) = false);

  -- Una sola llamada cada uno: liberar MUTA, llamarlo dos veces mediría la
  -- segunda pasada (que ya no encuentra nada) en vez del efecto real.
  v_lib_ab := liberar_slug_abandonado(v_slug);
  v_lib_vi := liberar_slug_abandonado(v_slugv);
  INSERT INTO _res VALUES ('5 liberar renombra el abandonado', 'true', v_lib_ab::text, v_lib_ab = true);
  INSERT INTO _res VALUES ('6 liberar NO toca al vivo', 'false', v_lib_vi::text, v_lib_vi = false);
  INSERT INTO _res VALUES ('7 el slug liberado quedo renombrado', 'true',
    (SELECT (slug <> v_slug)::text FROM tenants WHERE id = v_tid),
    (SELECT slug <> v_slug FROM tenants WHERE id = v_tid) = true);
  INSERT INTO _res VALUES ('8 el demo nunca se libera', 'false',
    COALESCE((SELECT tenant_abandonado(id)::text FROM tenants WHERE slug = 'healthyspace'), 'sin-demo'),
    COALESCE((SELECT tenant_abandonado(id) FROM tenants WHERE slug = 'healthyspace'), false) = false);

  -- Limpieza (no dejamos basura de test).
  DELETE FROM suscripciones_saas WHERE tenant_id IN (v_tid, v_vivo);
  DELETE FROM tenants WHERE id IN (v_tid, v_vivo);
END $$;

SELECT caso, esperado, obtenido, CASE WHEN ok THEN 'OK' ELSE '*** FALLO ***' END AS resultado
FROM _res ORDER BY caso;