-- ============================================================================
-- El dinero no se podía devolver
-- ----------------------------------------------------------------------------
-- `pagos` es un ledger append-only: un cobro no se edita ni se borra. Correcto.
-- Pero NO existía la otra mitad del sistema: el asiento de reverso.
--
--   · concepto CHECK IN ('plan','inscripcion','paquete','otro')  → no hay reembolso
--   · monto_centavos CHECK (>= 0)                                → no hay negativos
--   · trigger append-only                                        → no se corrige
--
-- El comentario de la tabla decía "se corrige con otro asiento", pero no había
-- ningún asiento posible que restara. Resultado: el primer cobro doble, el primer
-- socio arrepentido, el primer error de tipeo de recepción — y la caja queda mal
-- PARA SIEMPRE, sin forma de arreglarla. Cada día que pasa es más historia falsa
-- que reconstruir.
--
-- Un reembolso acá es lo que es en contabilidad: un asiento NUEVO, negativo, que
-- apunta al cobro que revierte. El cobro original queda intacto y auditable. La
-- caja lo suma solo (un negativo resta) sin tocar ninguna cuenta.
--
-- LO QUE ESTO **NO** HACE, a propósito:
--   · No mueve dinero. Si el cobro fue por Stripe, la plata se devuelve DESDE
--     Stripe; esto registra que se devolvió. Si fue en efectivo, la plata sale de
--     la caja física. El sistema lleva la cuenta, no la billetera.
--   · No toca la membresía ni los créditos. Devolver la plata y dar de baja el
--     plan son dos decisiones distintas, y el gym puede querer una sin la otra.
-- ============================================================================

-- ── 1) El schema admite el reverso ──────────────────────────────────────────

-- A qué cobro revierte este asiento. Solo lo tienen los reembolsos.
ALTER TABLE pagos
  ADD COLUMN IF NOT EXISTS revierte_pago_id uuid REFERENCES pagos(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS pagos_revierte_idx ON pagos (revierte_pago_id)
  WHERE revierte_pago_id IS NOT NULL;

-- Los CHECK originales son anónimos (los nombró Postgres). Los buscamos por lo
-- que hacen en vez de adivinarles el nombre.
DO $$
DECLARE
  v_con text;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'pagos'::regclass
      AND contype = 'c'
      AND (
        pg_get_constraintdef(oid) LIKE '%monto_centavos >= 0%'
        OR pg_get_constraintdef(oid) LIKE '%concepto = ANY%'
      )
  LOOP
    EXECUTE format('ALTER TABLE pagos DROP CONSTRAINT %I', v_con);
  END LOOP;
END;
$$;

ALTER TABLE pagos
  ADD CONSTRAINT pagos_concepto_valido
  CHECK (concepto IN ('plan', 'inscripcion', 'paquete', 'otro', 'reembolso'));

-- La forma de un asiento depende de su signo, y no hay forma de escribir uno
-- incoherente: un reembolso es negativo y apunta a un cobro; un cobro es positivo
-- y no apunta a nada.
ALTER TABLE pagos
  ADD CONSTRAINT pagos_asiento_coherente
  CHECK (
    (concepto = 'reembolso' AND monto_centavos < 0 AND revierte_pago_id IS NOT NULL)
    OR
    (concepto <> 'reembolso' AND monto_centavos >= 0 AND revierte_pago_id IS NULL)
  );

COMMENT ON COLUMN pagos.revierte_pago_id IS
  'Solo en los reembolsos: el cobro que este asiento revierte. El cobro original '
  'nunca se toca — el ledger es append-only y el reverso es una fila nueva.';

COMMENT ON TABLE pagos IS
  'Ledger append-only de DINERO del socio. Los cobros son positivos (plan, '
  'inscripción, paquete); los reembolsos son asientos NEGATIVOS que apuntan al '
  'cobro que revierten (revierte_pago_id). Nada se edita ni se borra: una '
  'corrección es siempre una fila nueva. Solo lo escriben RPCs SECURITY DEFINER.';


-- ── 2) Cuánto queda por devolver de un cobro ────────────────────────────────
-- Un cobro se puede reembolsar en partes (el gym devuelve la mitad, o la
-- inscripción pero no el plan). Esto es lo que todavía no se devolvió.
CREATE OR REPLACE FUNCTION pago_reembolsable(p_pago_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(
    p.monto_centavos - COALESCE((
      SELECT SUM(-r.monto_centavos)
      FROM pagos r
      WHERE r.revierte_pago_id = p.id
    ), 0),
    0
  )::integer
  FROM pagos p
  WHERE p.id = p_pago_id
    AND p.concepto <> 'reembolso';
$$;

REVOKE ALL ON FUNCTION pago_reembolsable(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION pago_reembolsable(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION pago_reembolsable(uuid) TO authenticated;


-- ── 2b) La bitácora rechazaba acciones que el sistema SÍ usa ────────────────
-- `auditoria_recepcion.accion` es una lista CERRADA, y escribir una acción que no
-- esté en ella NO falla al crear la función: Postgres no valida ese literal. Falla
-- EN PRODUCCIÓN, la primera vez que alguien aprieta el botón. Es la peor forma de
-- bug que tiene este sistema: silencioso al escribirlo, ruidoso en la cara del
-- usuario meses después.
--
-- Hay DOS acciones rotas hoy, y las dos por el mismo accidente — reescribir la
-- lista a mano y perder una entrada:
--
--   · 'membresia.alta'   → la agregó 20260612050000 para recepcion_asignar_plan.
--                          20260613001700 y 20260709190000 reescribieron la lista
--                          y LA PERDIERON. Resultado: ASIGNAR UN PLAN DESDE
--                          RECEPCIÓN está roto en producción ahora mismo.
--   · 'asistencia.admin' → la inventó 20260715120000 (admin_marcar_asistencia) sin
--                          agregarla nunca a la lista. Marcar asistencia desde la
--                          agenda del admin también revienta. Se corrige abajo
--                          usando 'clase.marcar_asistencia', que ya existía.
--
-- La lista de acá abajo NO se copió a ojo: se extrajo de TODAS las llamadas a
-- _audrec_log del código y se comparó una por una. Y el test del final hace esa
-- misma comparación contra la base, así que la próxima reescritura descuidada
-- rompe la migración en vez de romper el gimnasio.
ALTER TABLE auditoria_recepcion DROP CONSTRAINT IF EXISTS auditoria_recepcion_accion_check;
ALTER TABLE auditoria_recepcion ADD CONSTRAINT auditoria_recepcion_accion_check
  CHECK (accion IN (
    'membresia.alta','membresia.renovar','membresia.cambiar_plan','membresia.recargar_creditos',
    'membresia.congelar','membresia.reactivar','membresia.cancelar',
    'reserva.crear','reserva.cancelar','reserva.lista_espera_anotar','reserva.lista_espera_promover',
    'socio.crear','socio.editar_contacto','socio.reset_password','socio.bloquear','socio.desbloquear','socio.nota','socio.aviso',
    'clase.crear','clase.cancelar','clase.editar','clase.reasignar_coach','clase.marcar_asistencia','clase.marcar_no_show',
    'pago.reenviar_link','pago.activar','pago.reembolso',
    'checkin.manual','checkin.qr','checkin.corregir'
  ));

-- El fix del bug vivo: la acción correcta ya existía.
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'admin_marcar_asistencia';

  IF v_src IS NULL THEN
    RAISE NOTICE 'admin_marcar_asistencia no existe todavía; nada que arreglar.';
  ELSIF position('asistencia.admin' IN v_src) > 0 THEN
    EXECUTE replace(
      pg_get_functiondef('admin_marcar_asistencia(uuid, text)'::regprocedure),
      '''asistencia.admin''',
      '''clase.marcar_asistencia'''
    );
    RAISE NOTICE 'admin_marcar_asistencia: acción de bitácora corregida.';
  END IF;
END;
$$;


-- ── 2c) cerrar_tenant() no podía cerrar un gym con bitácora ─────────────────
-- Bug de 20260715140000, que se descubrió recién ahora porque los seis tenants de
-- prueba que borramos no tenían ni una línea de bitácora.
--
-- Al borrar los usuarios, la FK `auditoria_recepcion.actor_id ON DELETE SET NULL`
-- dispara un UPDATE sobre la bitácora... que el trigger append-only bloquea. O
-- sea: un gym que operó de verdad (que tiene bitácora, o sea TODOS) no se podía
-- dar de baja. Justo lo que esa función existía para arreglar.
--
-- Misma solución que en `pagos`: la bitácora cede SOLO dentro de cerrar_tenant(),
-- reconociendo el flag de transacción que esa función prende. Editar o borrar una
-- línea de bitácora a mano sigue siendo imposible.
CREATE OR REPLACE FUNCTION trg_audrec_no_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('sala.cierre_tenant', true) = 'on' THEN
    RETURN NEW;  -- el cierre del gym desengancha a los actores borrados
  END IF;
  RAISE EXCEPTION 'auditoria_recepcion es append-only: UPDATE no permitido';
END;
$$;

CREATE OR REPLACE FUNCTION trg_audrec_no_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Cascade desde el tenant (depth > 1) o cierre explícito: permitido.
  IF pg_trigger_depth() > 1 OR current_setting('sala.cierre_tenant', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'auditoria_recepcion es append-only: DELETE directo no permitido';
END;
$$;

-- El ledger de créditos tiene EXACTAMENTE el mismo problema: bloquea UPDATE, y
-- `membresia_movimientos.created_by` también es ON DELETE SET NULL contra
-- usuarios. Habría sido el siguiente error, un intento después.
CREATE OR REPLACE FUNCTION trg_membresia_mov_no_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('sala.cierre_tenant', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'membresia_movimientos es append-only: UPDATE no permitido';
END;
$$;


-- ── 3) Registrar un reembolso ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION registrar_reembolso(
  p_pago_id uuid,
  p_monto_centavos integer DEFAULT NULL,  -- NULL = devolver todo lo que queda
  p_motivo text DEFAULT NULL
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
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  -- is_recepcionista() incluye al admin.
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden devolver dinero';
  END IF;

  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO: Un reembolso sin motivo no se puede auditar después';
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

  -- Una cortesía no movió dinero: no hay nada que devolver.
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

  -- El asiento negativo. Mismo método y misma moneda que el cobro original: la
  -- plata vuelve por donde vino, y así la caja cuadra por método.
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

  RETURN jsonb_build_object(
    'success', true,
    'reembolso_id', v_reembolso_id,
    'monto_centavos', v_monto,
    'moneda', v_pago.moneda,
    'metodo', v_pago.metodo,
    -- Lo que TODAVÍA queda por devolver de ese cobro (0 = ya se devolvió entero).
    'pendiente_centavos', v_disponible - v_monto,
    -- El dinero de Stripe se devuelve desde Stripe: esto solo lo asienta.
    'requiere_accion_en_stripe', v_pago.metodo = 'stripe'
  );
END;
$$;

REVOKE ALL ON FUNCTION registrar_reembolso(uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION registrar_reembolso(uuid, integer, text) FROM anon;
GRANT EXECUTE ON FUNCTION registrar_reembolso(uuid, integer, text) TO authenticated;

COMMENT ON FUNCTION registrar_reembolso(uuid, integer, text) IS
  'Asienta la devolución (total o parcial) de un cobro. NO mueve dinero: si el '
  'cobro fue por Stripe, la plata se devuelve desde Stripe. NO toca la membresía '
  'ni los créditos: devolver plata y dar de baja el plan son decisiones distintas.';


-- ============================================================================
-- TEST DE CONTRATO: ninguna función puede escribir una acción que la bitácora
-- no acepte.
-- ----------------------------------------------------------------------------
-- Este es el bug que acabamos de encontrar, y su forma es traicionera: la
-- función se CREA sin problema (Postgres no valida el literal), y explota meses
-- después, en producción, cuando alguien aprieta el botón por primera vez.
--
-- Acá sacamos de TODAS las funciones las acciones que le pasan a _audrec_log y
-- las comparamos contra la lista permitida. Si una no está, la migración falla.
-- ============================================================================
DO $$
DECLARE
  v_check text;
  v_accion text;
  v_faltan text[] := ARRAY[]::text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_check
  FROM pg_constraint WHERE conname = 'auditoria_recepcion_accion_check';

  FOR v_accion IN
    SELECT DISTINCT m[1]
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
         LATERAL regexp_matches(p.prosrc, '_audrec_log\(\s*''([a-z_]+\.[a-z_]+)''', 'g') AS m
    WHERE n.nspname = 'public'
  LOOP
    IF position('''' || v_accion || '''' IN v_check) = 0 THEN
      v_faltan := array_append(v_faltan, v_accion);
    END IF;
  END LOOP;

  IF cardinality(v_faltan) > 0 THEN
    RAISE EXCEPTION
      'ACCION_NO_PERMITIDA: estas funciones escriben acciones que la bitácora rechaza (explotarían en producción): %',
      array_to_string(v_faltan, ', ');
  END IF;
END;
$$;


-- ============================================================================
-- SELF-TEST — con dinero de verdad no alcanza con "compila".
-- ============================================================================
DO $$
DECLARE
  v_tenant uuid;
  v_admin uuid;
  v_socio uuid;
  v_pago uuid;
  v_cortesia uuid;
  v_auth uuid := gen_random_uuid();
  v_slug text := 'zz-test-reemb-' || substr(md5(random()::text), 1, 6);
  v_res jsonb;
  v_err text;
  v_neto integer;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test reembolsos', 'gym_libre', 'activo')
  RETURNING id INTO v_tenant;

  -- La cuenta de login del admin de prueba. OJO: insertar en auth.users dispara
  -- el trigger on_auth_user_created, que YA crea la fila de `usuarios` (como
  -- 'miembro'). Por eso el tenant va en el metadata —si no, el trigger lo mete en
  -- el demo— y después se lo promueve a admin, en vez de insertarlo a mano.
  INSERT INTO auth.users (
    id, instance_id, aud, role, email, raw_user_meta_data,
    encrypted_password, email_confirmed_at, created_at, updated_at
  )
  VALUES (
    v_auth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    v_slug || '-admin@sala.dev',
    jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'),
    '', now(), now(), now()
  );

  UPDATE usuarios
  SET rol = 'admin', status = 'activo'
  WHERE auth_id = v_auth
  RETURNING id INTO v_admin;

  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'FALLA: el trigger de signup no creó al usuario del gym de prueba';
  END IF;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug || '-socio@sala.dev', 'Socio', 'miembro', 'activo')
  RETURNING id INTO v_socio;

  -- Un cobro de $1.000 y una cortesía.
  INSERT INTO pagos (tenant_id, usuario_id, concepto, metodo, monto_centavos, moneda)
  VALUES (v_tenant, v_socio, 'plan', 'efectivo', 100000, 'MXN')
  RETURNING id INTO v_pago;

  INSERT INTO pagos (tenant_id, usuario_id, concepto, metodo, monto_centavos, moneda)
  VALUES (v_tenant, v_socio, 'plan', 'cortesia', 0, 'MXN')
  RETURNING id INTO v_cortesia;

  -- Nos hacemos pasar por el admin del tenant: las RPCs resuelven al actor desde
  -- el JWT (get_my_user_id / is_recepcionista miran auth.uid()).
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_auth::text)::text, true);

  -- 1) Reembolso PARCIAL: $400 de los $1.000.
  v_res := registrar_reembolso(v_pago, 40000, 'Cobro duplicado por error de mostrador');
  IF (v_res->>'pendiente_centavos')::integer <> 60000 THEN
    RAISE EXCEPTION 'FALLA: tras devolver 400 de 1000 deberían quedar 600, quedan %',
      v_res->>'pendiente_centavos';
  END IF;

  -- 2) No se puede devolver más de lo que queda.
  BEGIN
    PERFORM registrar_reembolso(v_pago, 70000, 'Intento de devolver de más');
    RAISE EXCEPTION 'FALLA: dejó devolver más de lo cobrado';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'MONTO_EXCEDE%' THEN RAISE; END IF;
  END;

  -- 3) Un reembolso sin motivo no se puede auditar: se rechaza.
  BEGIN
    PERFORM registrar_reembolso(v_pago, 1000, NULL);
    RAISE EXCEPTION 'FALLA: aceptó un reembolso sin motivo';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'MOTIVO_REQUERIDO%' THEN RAISE; END IF;
  END;

  -- 4) Una cortesía no cobró nada: no hay nada que devolver.
  BEGIN
    PERFORM registrar_reembolso(v_cortesia, NULL, 'Intento sobre cortesía');
    RAISE EXCEPTION 'FALLA: dejó reembolsar una cortesía';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'NO_REEMBOLSABLE%' THEN RAISE; END IF;
  END;

  -- 5) Devolver el resto: NULL = todo lo que quede.
  v_res := registrar_reembolso(v_pago, NULL, 'Se devuelve el resto');
  IF (v_res->>'monto_centavos')::integer <> 60000 THEN
    RAISE EXCEPTION 'FALLA: NULL debería devolver los 600 restantes, devolvió %',
      v_res->>'monto_centavos';
  END IF;

  -- 6) Ya no queda nada.
  BEGIN
    PERFORM registrar_reembolso(v_pago, 100, 'Intento sobre un cobro ya devuelto');
    RAISE EXCEPTION 'FALLA: dejó devolver sobre un cobro ya reembolsado entero';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'YA_REEMBOLSADO%' THEN RAISE; END IF;
  END;

  -- 7) LA PRUEBA QUE IMPORTA: la caja cuadra en cero. El cobro original sigue
  --    ahí, intacto y auditable, y los dos reversos lo anulan.
  SELECT COALESCE(SUM(monto_centavos), -1) INTO v_neto
  FROM pagos WHERE tenant_id = v_tenant AND metodo <> 'cortesia';

  IF v_neto <> 0 THEN
    RAISE EXCEPTION 'FALLA: la caja debería quedar en 0 y quedó en %', v_neto;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pagos WHERE id = v_pago AND monto_centavos = 100000) THEN
    RAISE EXCEPTION 'FALLA: el cobro original se tocó. El ledger es append-only.';
  END IF;

  -- Limpieza.
  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
END;
$$;

SELECT 'reembolso parcial, tope, motivo obligatorio, cortesía, doble reembolso' AS prueba,
       'todo cubierto' AS espera,
       'OK' AS resultado
UNION ALL
SELECT 'la caja neta queda en 0 y el cobro original sigue intacto',
       'append-only respetado', 'OK'
UNION ALL
SELECT 'anon no puede devolver dinero',
       'sin EXECUTE para anon',
       CASE WHEN has_function_privilege('anon', 'registrar_reembolso(uuid, integer, text)', 'EXECUTE')
            THEN 'FALLA' ELSE 'OK' END;
