-- ============================================================================
-- TESTS — DINERO Y ACCESO (las reglas donde un error cuesta plata)
-- ============================================================================
-- USO: pegar entero en el SQL Editor de Supabase y ejecutar.
--      Va envuelto en BEGIN/ROLLBACK → NO persiste NADA.
--      El veredicto sale como TABLA al final (pestaña Results).
--
-- Arma su PROPIO tenant de prueba dentro de la transacción: no depende de los
-- datos de ningún gym real, así que da lo mismo cuándo y cuántas veces se corra.
--
-- Qué cubre (todo lo construido en el sprint de cobros/invitados/walk-in):
--   1. La inscripción se cobra UNA vez (al alta) y no se repite al renovar.
--   2. Sin método de pago no se registra dinero (cortesía / ya pagó online).
--   3. La bolsa de invitados es POR PERIODO, no por clase: no se puede exceder.
--   4. Un plan sin pases rechaza invitados.
--   5. El walk-in de recepción IGNORA la anticipación mínima…
--   6. …pero NO ignora el cupo.
--   7. Cancelar devuelve los créditos del titular Y de sus invitados (el bug
--      que una migración vieja había pisado).
-- ============================================================================

BEGIN;

-- ── helpers ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp._as(p_auth_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_auth_id IS NULL THEN
    PERFORM set_config('request.jwt.claims', '', true);
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', p_auth_id::text)::text, true);
  END IF;
END $$;

CREATE TEMP TABLE _r (n int PRIMARY KEY, test text, ok boolean, detalle text);
CREATE TEMP TABLE _ctx (
  tenant_id uuid, sucursal_id uuid, recurso_id uuid,
  tier_ilimitado uuid,   -- tiempo, inscripción $400, 2 pases de invitado
  tier_paquete uuid,     -- créditos, 10 clases, sin inscripción, sin pases
  staff_auth uuid, socio_id uuid, socio_auth uuid, socio2_id uuid,
  clase_pronto uuid,     -- empieza en 30 min (viola la anticipación mínima)
  clase_llena uuid
);

-- ── SETUP ──────────────────────────────────────────────────────────────────
DO $setup$
DECLARE
  v_tenant uuid; v_suc uuid; v_rec uuid;
  v_t_ilim uuid; v_t_paq uuid;
  v_staff_auth uuid := gen_random_uuid();
  v_socio_auth uuid := gen_random_uuid();
  v_socio2_auth uuid := gen_random_uuid();
  v_socio uuid; v_socio2 uuid;
  v_clase_pronto uuid; v_clase_llena uuid;
  v_slug text := 'tst' || substr(gen_random_uuid()::text, 1, 8);
BEGIN
  -- Tenant con anticipación mínima de 24h: así el walk-in tiene algo que saltear.
  INSERT INTO tenants (slug, nombre, config, status)
  VALUES (v_slug, 'Test Gym', jsonb_build_object(
    'timezone', 'America/Mexico_City',
    'reserva', jsonb_build_object('anticipacion_min_horas', 24, 'cancelacion_min_horas', 4)
  ), 'activo')
  RETURNING id INTO v_tenant;

  INSERT INTO sucursales (tenant_id, nombre, timezone, activa, orden)
  VALUES (v_tenant, 'Única', 'America/Mexico_City', true, 1)
  RETURNING id INTO v_suc;

  INSERT INTO recursos (tenant_id, sucursal_id, slug, nombre, activo, cupo_max_default, tiers_permitidos)
  VALUES (v_tenant, v_suc, 'sala', 'Sala', true, 10, ARRAY['ilimitado','paquete'])
  RETURNING id INTO v_rec;

  -- Plan por TIEMPO con inscripción de $400 y 2 pases de invitado por periodo.
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, periodo, tipo,
                     duracion_dias, inscripcion_centavos, invitados_por_periodo, activo)
  VALUES (v_tenant, 'ilimitado', 'Ilimitado', 100000, 'mensual', 'tiempo',
          30, 40000, 2, true)
  RETURNING id INTO v_t_ilim;

  -- Plan por CRÉDITOS: 10 clases, sin inscripción, sin pases.
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, periodo, tipo,
                     duracion_dias, clases_incluidas, inscripcion_centavos,
                     invitados_por_periodo, activo)
  VALUES (v_tenant, 'paquete', 'Paquete', 60000, 'mensual', 'creditos',
          30, 10, 0, 0, true)
  RETURNING id INTO v_t_paq;

  -- Usuarios (el trigger de auth crea la fila en `usuarios` con tenant_slug).
  INSERT INTO auth.users (instance_id, id, aud, role, email,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES
    ('00000000-0000-0000-0000-000000000000', v_staff_auth, 'authenticated', 'authenticated',
     'staff-' || v_slug || '@test.local',
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Recepción Test'), now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_socio_auth, 'authenticated', 'authenticated',
     'socio-' || v_slug || '@test.local',
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Socio Test'), now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_socio2_auth, 'authenticated', 'authenticated',
     'socio2-' || v_slug || '@test.local',
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Socio Dos'), now(), now());

  UPDATE usuarios SET rol = 'recepcionista', status = 'activo' WHERE auth_id = v_staff_auth;
  UPDATE usuarios SET status = 'activo' WHERE auth_id IN (v_socio_auth, v_socio2_auth);

  SELECT id INTO v_socio  FROM usuarios WHERE auth_id = v_socio_auth;
  SELECT id INTO v_socio2 FROM usuarios WHERE auth_id = v_socio2_auth;

  -- Clase que empieza en 30 min: para un socio viola la anticipación (24h),
  -- para el mostrador es un walk-in normal.
  INSERT INTO clases (tenant_id, sucursal_id, recurso_id, fecha, hora_inicio,
                      duracion_minutos, nombre, cupo_max, origen, status)
  VALUES (v_tenant, v_suc, v_rec,
          ((now() + interval '30 minutes') AT TIME ZONE 'America/Mexico_City')::date,
          ((now() + interval '30 minutes') AT TIME ZONE 'America/Mexico_City')::time,
          60, 'Clase pronto', 10, 'manual', 'programada')
  RETURNING id INTO v_clase_pronto;

  -- Clase con cupo 1, ya ocupada por otro socio → llena.
  INSERT INTO clases (tenant_id, sucursal_id, recurso_id, fecha, hora_inicio,
                      duracion_minutos, nombre, cupo_max, origen, status)
  VALUES (v_tenant, v_suc, v_rec,
          ((now() + interval '2 hours') AT TIME ZONE 'America/Mexico_City')::date,
          ((now() + interval '2 hours') AT TIME ZONE 'America/Mexico_City')::time,
          60, 'Clase llena', 1, 'manual', 'programada')
  RETURNING id INTO v_clase_llena;

  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, clase_id,
                        slot_inicio, slot_fin, duracion_min, invitados_count, status, folio)
  VALUES (v_tenant, v_rec, v_socio2, v_clase_llena,
          now() + interval '2 hours', now() + interval '3 hours', 60, 0, 'confirmada', 'TST-000001');

  INSERT INTO _ctx VALUES (v_tenant, v_suc, v_rec, v_t_ilim, v_t_paq,
                           v_staff_auth, v_socio, v_socio_auth, v_socio2,
                           v_clase_pronto, v_clase_llena);
END $setup$;

-- ============================================================================
-- 1) La inscripción se cobra UNA vez, en el alta
-- ============================================================================
DO $t$
DECLARE c record; v_pagos int; v_inscr int; v_marca timestamptz;
BEGIN
  SELECT * INTO c FROM _ctx;
  PERFORM pg_temp._as(c.staff_auth);

  PERFORM gestionar_membresia_socio(c.socio_id, c.tier_ilimitado, 'Alta test', 'efectivo', NULL);

  SELECT count(*) FILTER (WHERE concepto = 'plan'),
         count(*) FILTER (WHERE concepto = 'inscripcion')
  INTO v_pagos, v_inscr
  FROM pagos WHERE usuario_id = c.socio_id;

  SELECT inscripcion_pagada_at INTO v_marca FROM usuarios WHERE id = c.socio_id;

  INSERT INTO _r VALUES (1, 'Alta con método: cobra plan + inscripción y marca al socio',
    v_pagos = 1 AND v_inscr = 1 AND v_marca IS NOT NULL,
    format('plan=%s inscripcion=%s marcado=%s', v_pagos, v_inscr, v_marca IS NOT NULL));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _r VALUES (1, 'Alta con método: cobra plan + inscripción y marca al socio',
    false, 'error: ' || SQLERRM);
END $t$;

-- ============================================================================
-- 2) Renovar NO vuelve a cobrar la inscripción
-- ============================================================================
DO $t$
DECLARE c record; v_inscr int; v_planes int;
BEGIN
  SELECT * INTO c FROM _ctx;
  PERFORM pg_temp._as(c.staff_auth);

  PERFORM gestionar_membresia_socio(c.socio_id, c.tier_ilimitado, 'Renovación test', 'efectivo', NULL);

  SELECT count(*) FILTER (WHERE concepto = 'inscripcion'),
         count(*) FILTER (WHERE concepto = 'plan')
  INTO v_inscr, v_planes
  FROM pagos WHERE usuario_id = c.socio_id;

  INSERT INTO _r VALUES (2, 'Renovar NO vuelve a cobrar inscripción',
    v_inscr = 1 AND v_planes = 2,
    format('inscripciones=%s (debe ser 1) · cobros de plan=%s (debe ser 2)', v_inscr, v_planes));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _r VALUES (2, 'Renovar NO vuelve a cobrar inscripción', false, 'error: ' || SQLERRM);
END $t$;

-- ============================================================================
-- 3) Sin método de pago no se registra dinero (cortesía / ya pagó online)
-- ============================================================================
DO $t$
DECLARE c record; v_antes int; v_despues int;
BEGIN
  SELECT * INTO c FROM _ctx;
  PERFORM pg_temp._as(c.staff_auth);

  SELECT count(*) INTO v_antes FROM pagos WHERE usuario_id = c.socio2_id;
  PERFORM gestionar_membresia_socio(c.socio2_id, c.tier_ilimitado, 'Cortesía', NULL, NULL);
  SELECT count(*) INTO v_despues FROM pagos WHERE usuario_id = c.socio2_id;

  INSERT INTO _r VALUES (3, 'Sin método de pago no se registra ningún cobro',
    v_antes = 0 AND v_despues = 0,
    format('pagos antes=%s despues=%s', v_antes, v_despues));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _r VALUES (3, 'Sin método de pago no se registra ningún cobro', false, 'error: ' || SQLERRM);
END $t$;

-- ============================================================================
-- 4) La bolsa de invitados no se puede exceder (2 pases, pide 3)
-- ============================================================================
DO $t$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM _ctx;
  PERFORM pg_temp._as(c.staff_auth);

  BEGIN
    PERFORM recepcion_crear_reserva(c.socio_id, c.clase_pronto, NULL, NULL, 3, NULL, NULL, 'test');
    INSERT INTO _r VALUES (4, 'La bolsa de invitados no se puede exceder (2 pases, pide 3)',
      false, 'NO falló: dejó reservar con 3 invitados teniendo 2 pases');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _r VALUES (4, 'La bolsa de invitados no se puede exceder (2 pases, pide 3)',
      SQLERRM LIKE '%INVITADOS_EXCEDEN%', 'error recibido: ' || SQLERRM);
  END;
END $t$;

-- ============================================================================
-- 5) Un plan sin pases rechaza invitados
-- ============================================================================
DO $t$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM _ctx;
  PERFORM pg_temp._as(c.staff_auth);

  -- socio2 pasa al plan de créditos (0 pases de invitado).
  PERFORM gestionar_membresia_socio(c.socio2_id, c.tier_paquete, 'Cambio a paquete', NULL, NULL);

  BEGIN
    PERFORM recepcion_crear_reserva(c.socio2_id, c.clase_pronto, NULL, NULL, 1, NULL, NULL, 'test');
    INSERT INTO _r VALUES (5, 'Un plan sin pases rechaza invitados',
      false, 'NO falló: dejó llevar un invitado con un plan que no los incluye');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _r VALUES (5, 'Un plan sin pases rechaza invitados',
      SQLERRM LIKE '%INVITADOS_NO_INCLUIDOS%', 'error recibido: ' || SQLERRM);
  END;
END $t$;

-- ============================================================================
-- 6) WALK-IN: recepción puede reservar una clase que empieza en 30 min
--    (el tenant exige 24h de anticipación → para el socio sería imposible)
-- ============================================================================
DO $t$
DECLARE c record; v_res jsonb; v_socio_falla text;
BEGIN
  SELECT * INTO c FROM _ctx;

  -- Primero: el SOCIO no puede (la anticipación mínima lo frena).
  PERFORM pg_temp._as(c.socio_auth);
  BEGIN
    PERFORM reservar_clase_atomic(c.clase_pronto, 0, NULL, NULL);
    v_socio_falla := 'el socio SÍ pudo (no debería)';
  EXCEPTION WHEN OTHERS THEN
    v_socio_falla := SQLERRM;
  END;

  -- Ahora: el mostrador sí puede.
  PERFORM pg_temp._as(c.staff_auth);
  SELECT recepcion_crear_reserva(c.socio_id, c.clase_pronto, NULL, NULL, 0, NULL, NULL, 'walk-in') INTO v_res;

  INSERT INTO _r VALUES (6, 'Walk-in: recepción ignora la anticipación mínima; el socio no',
    (v_res->>'success')::boolean AND v_socio_falla LIKE '%ANTICIPACION_INSUFICIENTE%',
    format('socio → %s | mostrador → folio %s', left(v_socio_falla, 40), v_res->>'folio'));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _r VALUES (6, 'Walk-in: recepción ignora la anticipación mínima; el socio no',
    false, 'error: ' || SQLERRM);
END $t$;

-- ============================================================================
-- 7) …pero el walk-in NO ignora el cupo
-- ============================================================================
DO $t$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM _ctx;
  PERFORM pg_temp._as(c.staff_auth);

  BEGIN
    PERFORM recepcion_crear_reserva(c.socio_id, c.clase_llena, NULL, NULL, 0, NULL, NULL, 'walk-in');
    INSERT INTO _r VALUES (7, 'El walk-in NO ignora el cupo (clase llena)',
      false, 'NO falló: metió a alguien en una clase llena');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _r VALUES (7, 'El walk-in NO ignora el cupo (clase llena)',
      SQLERRM LIKE '%CUPO_LLENO%', 'error recibido: ' || SQLERRM);
  END;
END $t$;

-- ============================================================================
-- 8) Cancelar devuelve los créditos del titular Y de sus invitados
--    (el bug que una migración vieja había pisado: devolvía 1 fijo)
-- ============================================================================
DO $t$
DECLARE
  c record; v_socio3_auth uuid := gen_random_uuid(); v_socio3 uuid;
  v_tier_inv uuid; v_clase uuid; v_res jsonb; v_reserva uuid;
  v_antes int; v_despues int; v_slug text;
BEGIN
  SELECT * INTO c FROM _ctx;
  SELECT slug INTO v_slug FROM tenants WHERE id = c.tenant_id;

  -- Plan de créditos CON pases de invitado (para debitar 1 + invitados).
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, periodo, tipo,
                     duracion_dias, clases_incluidas, invitados_por_periodo, activo)
  VALUES (c.tenant_id, 'paqinv', 'Paquete con invitados', 50000, 'mensual', 'creditos',
          30, 10, 5, true)
  RETURNING id INTO v_tier_inv;

  -- array_append: 'texto || array' hace que Postgres intente castear el texto a
  -- array y falle con "malformed array literal".
  UPDATE recursos
  SET tiers_permitidos = array_append(tiers_permitidos, 'paqinv')
  WHERE id = c.recurso_id;

  INSERT INTO auth.users (instance_id, id, aud, role, email,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000', v_socio3_auth, 'authenticated', 'authenticated',
          'socio3-' || v_slug || '@test.local',
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Socio Tres'), now(), now());
  SELECT id INTO v_socio3 FROM usuarios WHERE auth_id = v_socio3_auth;
  UPDATE usuarios SET status = 'activo' WHERE id = v_socio3;

  PERFORM pg_temp._as(c.staff_auth);
  PERFORM gestionar_membresia_socio(v_socio3, v_tier_inv, 'Alta', NULL, NULL);

  -- Clase futura (fuera de la ventana de cancelación de 4h → devuelve crédito).
  INSERT INTO clases (tenant_id, sucursal_id, recurso_id, fecha, hora_inicio,
                      duracion_minutos, nombre, cupo_max, origen, status)
  VALUES (c.tenant_id, c.sucursal_id, c.recurso_id,
          ((now() + interval '48 hours') AT TIME ZONE 'America/Mexico_City')::date,
          ((now() + interval '48 hours') AT TIME ZONE 'America/Mexico_City')::time,
          60, 'Clase lejos', 10, 'manual', 'programada')
  RETURNING id INTO v_clase;

  SELECT creditos_restantes INTO v_antes
  FROM membresias WHERE usuario_id = v_socio3 AND status = 'activa';

  -- El socio reserva con 2 invitados → se le debitan 3 créditos.
  PERFORM pg_temp._as(v_socio3_auth);
  SELECT reservar_clase_atomic(v_clase, 2, NULL, NULL) INTO v_res;
  v_reserva := (v_res->>'reserva_id')::uuid;

  -- Y cancela a tiempo → le tienen que volver los 3, no 1.
  PERFORM cancelar_reserva_atomic(v_reserva, 'test');

  SELECT creditos_restantes INTO v_despues
  FROM membresias WHERE usuario_id = v_socio3 AND status = 'activa';

  INSERT INTO _r VALUES (8, 'Cancelar devuelve titular + invitados (no 1 fijo)',
    v_despues = v_antes,
    format('créditos antes=%s · después de reservar con 2 invitados y cancelar=%s (deben coincidir)',
           v_antes, v_despues));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _r VALUES (8, 'Cancelar devuelve titular + invitados (no 1 fijo)',
    false, 'error: ' || SQLERRM);
END $t$;

-- ============================================================================
-- Veredicto
-- ============================================================================
SELECT pg_temp._as(NULL);

SELECT
  n,
  CASE WHEN ok THEN '✅ OK  ' ELSE '❌ FAIL' END AS resultado,
  test,
  detalle
FROM _r
ORDER BY n;

ROLLBACK;
