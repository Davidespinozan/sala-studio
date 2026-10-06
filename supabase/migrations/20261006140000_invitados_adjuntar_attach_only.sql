-- ════════════════════════════════════════════════════════════════════════════
-- INVITADOS POST-RESERVA · ATTACH-ONLY V1 (hardening)
-- ────────────────────────────────────────────────────────────────────────────
-- Problema: agregar la IDENTIDAD de un invitado a una reserva ya existente
-- (INSERT directo del socio en reserva_invitados, o recepcion_agregar_invitado)
-- no validaba cupo, ni la bolsa de invitados, ni la sede, y un socio podía
-- insertar filas sin tener reserva propia válida → "seat-squatting" en salas con
-- mapa (bloqueaba asientos reales).
--
-- Decisiones del owner (V1):
--   · ATTACH-ONLY: solo se adjunta identidad a un lugar de invitado YA contado al
--     reservar (reservas.invitados_count). Nunca sube invitados_count, no consume
--     bolsa, no debita créditos, no aumenta ocupación.
--   · Sin quitar/decrementar invitados (ni socio ni recepción).
--   · Recepción NO agrega invitados en salas con mapa (igual que
--     recepcion_crear_reserva: LUGAR_SIN_INVITADOS).
--   · Salas con mapa (Diseño A): el socio manda p_lugar_id; el servidor lo valida
--     contra la ocupación real. Sin auto-asignación, sin asiento NULL.
--
-- Invariante: count(reserva_invitados de la reserva) <= reservas.invitados_count.
--
-- Cambios:
--   1) RLS de reserva_invitados: se retiran INSERT/UPDATE/DELETE directos (quedan
--      policies RESTRICTIVE en false) + REVOKE de escritura/TRUNCATE a
--      anon/authenticated. SELECT queda igual. Toda escritura va por RPC
--      SECURITY DEFINER.
--   2) adjuntar_invitado(...) — RPC canónica attach-only, idempotente.
--   3) recepcion_agregar_invitado(...) — misma firma; ahora es un wrapper staff de
--      adjuntar_invitado (hereda candado, conteo, sede, mapa, dedup).
--   4) Ghost-seat (solo salas con mapa): el asiento de un invitado deja de contar
--      cuando su reserva padre ya no está confirmada/completada — en
--      lugares_ocupados y en los dos checks de reservar_clase_atomic. El índice
--      único (clase_id, lugar_id) se reemplaza por uno NO único (un índice parcial
--      no puede mirar el status de otra tabla); la unicidad de asiento la
--      garantiza el advisory lock 'clase_lugares:<clase>' + recheck, igual que ya
--      se hacía para el asiento del titular.
--   5) recepcion_crear_reserva: su check de asiento también cuenta el asiento de
--      un invitado con reserva padre activa (antes solo miraba reservas.lugar_id
--      y, sin el índice único, podía sentar a un socio sobre un invitado). Ya
--      tomaba el lock 'clase_lugares' antes del check → solo cambia el predicado.
--   6) cambiar_lugar_reserva: entra al mismo invariante. Antes no tomaba ningún
--      lock (ni advisory ni FOR UPDATE) → podía sentar a dos personas en el mismo
--      lugar. Ahora: fila de la reserva FOR UPDATE → advisory 'clase_lugares'
--      (mismo orden que adjuntar_invitado y cancelar_reserva_atomic) → relectura
--      y decisión de disponibilidad DESPUÉS del lock, contando también el asiento
--      de un invitado con reserva padre activa. Auth/tenant/sede sin cambios.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1) Retiro de escrituras directas en reserva_invitados ───────────────────
DROP POLICY IF EXISTS reserva_invitados_insert ON reserva_invitados;
DROP POLICY IF EXISTS reserva_invitados_update ON reserva_invitados;
DROP POLICY IF EXISTS reserva_invitados_delete ON reserva_invitados;

-- Fail-closed explícito: aunque mañana alguien agregue una policy permisiva de
-- escritura, estas RESTRICTIVE la anulan (se combinan con AND).
DROP POLICY IF EXISTS reserva_invitados_no_insert ON reserva_invitados;
CREATE POLICY reserva_invitados_no_insert ON reserva_invitados
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
DROP POLICY IF EXISTS reserva_invitados_no_update ON reserva_invitados;
CREATE POLICY reserva_invitados_no_update ON reserva_invitados
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS reserva_invitados_no_delete ON reserva_invitados;
CREATE POLICY reserva_invitados_no_delete ON reserva_invitados
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);

-- TRUNCATE no pasa por RLS: si el rol lo tiene (default privileges de Supabase
-- conceden ALL), podía vaciar la tabla. Se revoca junto con la escritura directa.
-- SELECT se conserva (la policy reserva_invitados_select sigue igual).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON reserva_invitados FROM anon, authenticated;

-- ── 4a) Índice de asiento: único → no único (ver encabezado) ────────────────
DROP INDEX IF EXISTS reserva_invitados_lugar_unico;
CREATE INDEX IF NOT EXISTS reserva_invitados_clase_lugar_idx
  ON reserva_invitados (clase_id, lugar_id) WHERE lugar_id IS NOT NULL;

-- ── 2) adjuntar_invitado — attach-only ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.adjuntar_invitado(
  p_reserva_id uuid,
  p_nombre text,
  p_telefono text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_lugar_id text DEFAULT NULL,
  p_operation_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   uuid := get_my_user_id();
  v_tenant  uuid := get_my_tenant_id();
  v_staff   boolean;
  v_nombre  text := trim(COALESCE(p_nombre, ''));
  v_tel     text := NULLIF(trim(COALESCE(p_telefono, '')), '');
  v_email   text := NULLIF(lower(trim(COALESCE(p_email, ''))), '');
  v_lugar   text := NULLIF(trim(COALESCE(p_lugar_id, '')), '');
  v_reserva reservas;
  v_clase   clases;
  v_recurso recursos;
  v_adjuntos integer;
  v_socio   uuid;
  v_creado  boolean := false;
  v_inv_id  uuid;
  v_op      jsonb;
  v_owns    boolean := false;
  v_result  jsonb;
BEGIN
  -- (1) Actor real. Nada de lo relacional viene del cliente salvo p_reserva_id.
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  v_staff := is_recepcionista();  -- recepcionista o admin activo

  -- (2) Identidad. Contacto obligatorio solo para staff (mismo criterio que
  --     recepcion_agregar_invitado: crea/liga la ficha de socio del invitado).
  IF v_nombre = '' THEN
    RAISE EXCEPTION 'NOMBRE_REQUERIDO: El invitado necesita un nombre';
  END IF;
  IF v_staff AND v_tel IS NULL AND v_email IS NULL THEN
    RAISE EXCEPTION 'CONTACTO_REQUERIDO: El invitado necesita teléfono o email';
  END IF;

  -- (3) Idempotencia (antes de los guards de estado: el reintento converge al
  --     resultado original). El actor va en el hash: otra persona con la misma
  --     key → IDEMPOTENCY_CONFLICT, nunca el resultado ajeno.
  IF p_operation_key IS NOT NULL THEN
    v_op := _op_begin(
      v_tenant, p_operation_key, 'adjuntar_invitado', v_actor,
      md5(jsonb_build_object(
        'actor', v_actor, 'reserva', p_reserva_id, 'nombre', v_nombre,
        'telefono', v_tel, 'email', v_email, 'lugar', v_lugar)::text)
    );
    IF NOT (v_op->>'claimed')::boolean THEN
      RETURN COALESCE(v_op->'resultado', '{}'::jsonb) || jsonb_build_object('status', 'already_processed');
    END IF;
    v_owns := true;
  END IF;

  -- (4) Reserva resuelta en el servidor, acotada al tenant del actor, BLOQUEADA.
  --     Orden de locks: fila de reserva → (mapa) advisory 'clase_lugares'. Es el
  --     mismo orden que cancelar (UPDATE reservas → trigger de promoción).
  SELECT * INTO v_reserva FROM reservas
  WHERE id = p_reserva_id AND tenant_id = v_tenant
  FOR UPDATE;
  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: Esa reserva no existe en tu gimnasio';
  END IF;

  -- (5) Autorización: el socio solo sobre SU reserva; staff sobre cualquiera del
  --     tenant, con el guard de sede de #9 (sede = clases.sucursal_id).
  IF NOT v_staff AND v_reserva.usuario_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Esa reserva no es tuya';
  END IF;
  IF v_reserva.clase_id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_SIN_CLASE: Esa reserva no pertenece a una clase';
  END IF;
  SELECT * INTO v_clase FROM clases WHERE id = v_reserva.clase_id;
  IF v_clase.id IS NULL OR v_clase.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: Esta clase no existe en tu gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_reserva.clase_id));

  -- (6) Elegibilidad: la reserva sigue ocupando cupo y la clase no pasó.
  IF v_reserva.status NOT IN ('confirmada', 'completada') THEN
    RAISE EXCEPTION 'RESERVA_NO_ACTIVA: La reserva no está activa (status: %)', v_reserva.status;
  END IF;
  IF v_clase.status <> 'programada' THEN
    RAISE EXCEPTION 'CLASE_NO_PROGRAMADA: Esta clase no está disponible (status: %)', v_clase.status;
  END IF;
  -- Socio: igual que cancelar_reserva_atomic (no después de empezar la clase).
  -- Staff: hasta que la clase TERMINE — recepcion_crear_reserva admite walk-ins en
  -- una clase ya empezada y el modal registra a sus invitados justo después.
  IF NOT v_staff AND v_reserva.slot_inicio <= now() THEN
    RAISE EXCEPTION 'RESERVA_PASADA: La clase ya empezó';
  END IF;
  IF v_staff AND v_reserva.slot_fin <= now() THEN
    RAISE EXCEPTION 'RESERVA_PASADA: La clase ya terminó';
  END IF;

  -- (7) Invariante attach-only, bajo el lock de la fila: nunca más identidades
  --     que invitados ya contados al reservar.
  SELECT count(*) INTO v_adjuntos FROM reserva_invitados WHERE reserva_id = v_reserva.id;
  IF v_adjuntos >= COALESCE(v_reserva.invitados_count, 0) THEN
    RAISE EXCEPTION 'INVITADOS_COMPLETOS: Esta reserva ya tiene registrados sus % invitado(s)',
      COALESCE(v_reserva.invitados_count, 0);
  END IF;

  -- (8) Duplicado exacto en la misma reserva (mismo teléfono o email).
  IF (v_tel IS NOT NULL OR v_email IS NOT NULL) AND EXISTS (
    SELECT 1 FROM reserva_invitados
    WHERE reserva_id = v_reserva.id
      AND ((v_tel IS NOT NULL AND telefono = v_tel)
        OR (v_email IS NOT NULL AND lower(email) = v_email))
  ) THEN
    RAISE EXCEPTION 'INVITADO_DUPLICADO: Ese invitado ya está registrado en esta reserva';
  END IF;

  -- (9) Asiento. Mapa = Diseño A (lugar del cliente, validado contra ocupación real).
  SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;
  IF v_recurso.layout IS NOT NULL THEN
    IF v_staff THEN
      RAISE EXCEPTION 'LUGAR_SIN_INVITADOS: En salas con lugar asignado, cada persona reserva su propio lugar';
    END IF;
    IF v_lugar IS NULL THEN
      RAISE EXCEPTION 'LUGAR_REQUERIDO: Elige un lugar para tu invitado';
    END IF;
    -- Mismo advisory lock que reservar_clase_atomic: serializa asientos de la clase.
    PERFORM pg_advisory_xact_lock(hashtext('clase_lugares:' || v_reserva.clase_id::text));
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') AS l WHERE l->>'id' = v_lugar
    ) THEN
      RAISE EXCEPTION 'LUGAR_INVALIDO: Ese lugar no existe en la sala';
    END IF;
    IF EXISTS (
      SELECT 1 FROM reservas
      WHERE clase_id = v_reserva.clase_id AND lugar_id = v_lugar
        AND status IN ('confirmada','completada')
    ) OR EXISTS (
      SELECT 1 FROM reserva_invitados ri JOIN reservas pr ON pr.id = ri.reserva_id
      WHERE ri.clase_id = v_reserva.clase_id AND ri.lugar_id = v_lugar
        AND pr.status IN ('confirmada','completada')
    ) THEN
      RAISE EXCEPTION 'LUGAR_OCUPADO: Ese lugar ya está tomado, elige otro';
    END IF;
  ELSE
    v_lugar := NULL;  -- sala sin mapa: se ignora cualquier lugar
  END IF;

  -- (10) Staff: el invitado queda registrado como socio (busca-o-crea), igual que
  --      recepcion_agregar_invitado. El socio NO crea fichas (comportamiento previo
  --      del INSERT directo: usuario_id NULL).
  IF v_staff THEN
    SELECT id INTO v_socio
    FROM usuarios
    WHERE tenant_id = v_tenant AND rol = 'miembro'
      AND (
        (v_email IS NOT NULL AND lower(email) = v_email)
        OR (v_tel IS NOT NULL AND telefono = v_tel)
      )
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_socio IS NULL THEN
      INSERT INTO usuarios (tenant_id, nombre, email, telefono, rol, status, notas_admin)
      VALUES (
        v_tenant, v_nombre,
        COALESCE(v_email, 'invitado-' || gen_random_uuid() || '@sin-correo.local'),
        v_tel, 'miembro', 'activo',
        'Llegó como invitado el ' || to_char(now(), 'DD/MM/YYYY') || '. Sin plan todavía.'
      )
      RETURNING id INTO v_socio;
      v_creado := true;
    END IF;
  END IF;

  -- (11) Única escritura: la identidad. tenant/reserva/clase derivados del servidor.
  --      clase_id solo con asiento (mismo criterio que reservar_clase_atomic).
  INSERT INTO reserva_invitados (tenant_id, reserva_id, clase_id, nombre, telefono, email, lugar_id, usuario_id)
  VALUES (
    v_reserva.tenant_id, v_reserva.id,
    CASE WHEN v_lugar IS NOT NULL THEN v_reserva.clase_id END,
    v_nombre, v_tel, v_email, v_lugar, v_socio
  )
  RETURNING id INTO v_inv_id;

  v_result := jsonb_build_object(
    'success', true,
    'invitado_id', v_inv_id,
    'reserva_id', v_reserva.id,
    'usuario_id', v_socio,
    'creado', v_creado,
    'lugar_id', v_lugar,
    'invitados_registrados', v_adjuntos + 1,
    'invitados_count', v_reserva.invitados_count
  );
  IF v_owns THEN
    v_result := v_result || jsonb_build_object('status', 'ok');
    PERFORM _op_finish(v_tenant, p_operation_key, v_result);
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION adjuntar_invitado(uuid, text, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION adjuntar_invitado(uuid, text, text, text, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION adjuntar_invitado(uuid, text, text, text, text, uuid) TO authenticated;

COMMENT ON FUNCTION adjuntar_invitado(uuid, text, text, text, text, uuid) IS
  'Attach-only V1: adjunta la identidad de un invitado YA contado en reservas.invitados_count. Nunca sube el conteo, ni consume bolsa/créditos/cupo. Socio: solo su reserva, antes de que empiece la clase; staff: guard de sede #9, contacto obligatorio, sin salas con mapa.';

-- ── 3) recepcion_agregar_invitado — misma firma, wrapper staff ──────────────
CREATE OR REPLACE FUNCTION public.recepcion_agregar_invitado(
  p_reserva_id uuid,
  p_nombre text,
  p_telefono text DEFAULT NULL::text,
  p_email text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF get_my_user_id() IS NULL OR get_my_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden agregar invitados';
  END IF;
  -- Toda la lógica (lock, conteo, sede, mapa, dedup, ficha de socio) vive en la RPC
  -- canónica. Devuelve {success, usuario_id, creado, ...} como antes.
  RETURN adjuntar_invitado(p_reserva_id, p_nombre, p_telefono, p_email, NULL, NULL);
END;
$function$;

-- ── 4b) lugares_ocupados: asiento de invitado solo si la reserva padre está activa
CREATE OR REPLACE FUNCTION public.lugares_ocupados(p_clase_id uuid)
 RETURNS TABLE(lugar_id text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT r.lugar_id
  FROM reservas r
  JOIN clases c ON c.id = r.clase_id
  WHERE r.clase_id = p_clase_id
    AND r.status IN ('confirmada','completada')
    AND r.lugar_id IS NOT NULL
    AND c.tenant_id = get_my_tenant_id()
  UNION
  SELECT ri.lugar_id
  FROM reserva_invitados ri
  JOIN reservas pr ON pr.id = ri.reserva_id
  JOIN clases c ON c.id = ri.clase_id
  WHERE ri.clase_id = p_clase_id
    AND ri.lugar_id IS NOT NULL
    AND pr.status IN ('confirmada','completada')
    AND c.tenant_id = get_my_tenant_id();
$function$;

-- ── 4c) reservar_clase_atomic: cuerpo VIGENTE (20261005220000) + SOLO los dos
--        checks de asiento de invitado filtrados por status de la reserva padre.
--        CREATE OR REPLACE conserva owner y GRANTs.
CREATE OR REPLACE FUNCTION public.reservar_clase_atomic(p_clase_id uuid, p_invitados integer DEFAULT 0, p_notas text DEFAULT NULL::text, p_lugar_id text DEFAULT NULL::text, p_invitados_detalle jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_usuario usuarios;
  v_clase clases;
  v_recurso recursos;
  v_tenant tenants;
  v_now timestamptz := now();
  v_tz text;
  v_slot_inicio timestamptz;
  v_slot_fin timestamptz;
  v_min_anticipacion_min integer;
  v_cupos_ocupados integer;
  v_cupo_efectivo integer;
  v_existe_doble boolean;
  v_existe_continua boolean;
  v_permitir_continuas boolean;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;

  v_es_socio boolean;
  v_entitlement_source text;
  v_mem_id uuid;
  v_mem_status text;
  v_mem_inicio timestamptz;
  v_mem_fin timestamptz;
  v_mem_creditos integer;
  v_tier_tipo text;
  v_es_pase boolean;
  v_nuevo_creditos integer;
  v_costo integer;
  v_tier_todas_sedes boolean;
  v_mem_sucursal uuid;

  v_inv_incluidos integer;
  v_inv_usados integer;
  v_inv_disponibles integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;

  v_con_detalle boolean := (p_invitados_detalle IS NOT NULL AND jsonb_array_length(p_invitados_detalle) > 0);
  v_lugares_guest text[];
  v_lugares_todos text[];
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = v_user_id;
  SELECT * INTO v_clase   FROM clases   WHERE id = p_clase_id;
  SELECT * INTO v_tenant  FROM tenants  WHERE id = v_tenant_id;

  IF v_clase IS NULL OR v_clase.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: Esta clase no existe en tu gimnasio';
  END IF;

  v_tz := timezone_de_sucursal(v_clase.sucursal_id, v_clase.tenant_id);

  IF v_clase.status != 'programada' THEN
    RAISE EXCEPTION 'CLASE_NO_PROGRAMADA: Esta clase no está disponible (status: %)', v_clase.status;
  END IF;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;
  IF v_recurso IS NULL THEN
    RAISE EXCEPTION 'RECURSO_NO_EXISTE: Sala no encontrada';
  END IF;
  IF NOT v_recurso.activo THEN
    RAISE EXCEPTION 'RECURSO_INACTIVO: Esta sala no está disponible';
  END IF;

  -- W2-01: serializa TODA la reserva de ESTA clase (cupo + asientos) para TODAS
  -- las salas — no solo las de mapa. Sin esto, en salas de conteo dos socios
  -- distintos podían leer el mismo SUM y sobrevender el último lugar. Se toma acá,
  -- antes del cálculo de cupo y antes del FOR UPDATE de la membresía (mismo orden
  -- que ya usaban las salas con mapa → sin deadlock).
  PERFORM pg_advisory_xact_lock(hashtext('clase_lugares:' || p_clase_id::text));

  -- ── MAPA DE SALÓN ─────────────────────────────────────────────────────────
  IF v_recurso.layout IS NOT NULL THEN
    IF p_lugar_id IS NULL THEN
      RAISE EXCEPTION 'LUGAR_REQUERIDO: Elegí un lugar para esta clase';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') AS l WHERE l->>'id' = p_lugar_id
    ) THEN
      RAISE EXCEPTION 'LUGAR_INVALIDO: Ese lugar no existe en la sala';
    END IF;

    IF v_con_detalle THEN
      p_invitados := jsonb_array_length(p_invitados_detalle);

      IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_invitados_detalle) e WHERE NULLIF(trim(e->>'nombre'), '') IS NULL) THEN
        RAISE EXCEPTION 'INVITADO_SIN_NOMBRE: Cada invitado necesita un nombre';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_invitados_detalle) e WHERE NULLIF(trim(e->>'lugar_id'), '') IS NULL) THEN
        RAISE EXCEPTION 'LUGAR_REQUERIDO: Elegí un lugar para cada invitado';
      END IF;

      SELECT array_agg(e->>'lugar_id') INTO v_lugares_guest FROM jsonb_array_elements(p_invitados_detalle) e;
      v_lugares_todos := array_append(v_lugares_guest, p_lugar_id);

      IF (SELECT count(*) FROM unnest(v_lugares_todos)) <> (SELECT count(DISTINCT x) FROM unnest(v_lugares_todos) x) THEN
        RAISE EXCEPTION 'LUGAR_DUPLICADO: No repitas el mismo lugar';
      END IF;
      IF EXISTS (
        SELECT 1 FROM unnest(v_lugares_guest) g
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') l WHERE l->>'id' = g)
      ) THEN
        RAISE EXCEPTION 'LUGAR_INVALIDO: Un lugar de invitado no existe en la sala';
      END IF;
      IF EXISTS (
        SELECT 1 FROM reservas
        WHERE clase_id = p_clase_id AND status IN ('confirmada','completada')
          AND lugar_id = ANY(v_lugares_todos)
      ) OR EXISTS (
        -- Ghost-seat fix: el asiento de un invitado solo cuenta mientras su reserva
        -- padre siga ocupando lugar (mismo filtro de status que el titular).
        SELECT 1 FROM reserva_invitados ri JOIN reservas pr ON pr.id = ri.reserva_id
        WHERE ri.clase_id = p_clase_id AND ri.lugar_id = ANY(v_lugares_todos)
          AND pr.status IN ('confirmada','completada')
      ) THEN
        RAISE EXCEPTION 'LUGAR_OCUPADO: Uno de los lugares ya está tomado, elegí otro';
      END IF;
    ELSE
      IF p_invitados > 0 THEN
        RAISE EXCEPTION 'LUGAR_SIN_INVITADOS: Elegí un lugar para cada invitado';
      END IF;
      IF EXISTS (
        SELECT 1 FROM reservas
        WHERE clase_id = p_clase_id AND lugar_id = p_lugar_id AND status IN ('confirmada','completada')
      ) OR EXISTS (
        -- Ghost-seat fix: idem (asiento de invitado solo si la reserva padre está activa).
        SELECT 1 FROM reserva_invitados ri JOIN reservas pr ON pr.id = ri.reserva_id
        WHERE ri.clase_id = p_clase_id AND ri.lugar_id = p_lugar_id
          AND pr.status IN ('confirmada','completada')
      ) THEN
        RAISE EXCEPTION 'LUGAR_OCUPADO: Ese lugar ya está tomado, elegí otro';
      END IF;
    END IF;
  ELSE
    p_lugar_id := NULL; -- sala sin mapa: se ignora cualquier lugar (y p_invitados_detalle).
  END IF;

  v_es_socio := v_usuario.rol = 'miembro';
  -- #17A-1: provenance persistida al momento de autorizar, nunca reconstruida después.
  v_entitlement_source := CASE WHEN v_es_socio THEN 'membership' ELSE 'staff_benefit' END;

  IF v_usuario.status != 'activo' THEN
    RAISE EXCEPTION 'USUARIO_INACTIVO: Tu membresía no está activa (status: %)', v_usuario.status;
  END IF;

  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Tienes una restricción hasta el %',
      to_char(v_usuario.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  IF v_es_socio THEN
    SELECT m.id, m.status, m.periodo_actual_inicio, m.periodo_actual_fin,
           m.creditos_restantes, t.tipo,
           t.acceso_todas_sucursales, m.sucursal_id,
           COALESCE(t.invitados_por_periodo, 0),
           COALESCE(t.es_pase, false)
    INTO v_mem_id, v_mem_status, v_mem_inicio, v_mem_fin,
         v_mem_creditos, v_tier_tipo,
         v_tier_todas_sedes, v_mem_sucursal,
         v_inv_incluidos,
         v_es_pase
    FROM membresias m
    JOIN tiers t ON t.id = m.tier_id
    WHERE m.usuario_id = v_user_id
      AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
    ORDER BY
      CASE m.status
        WHEN 'activa'    THEN 0
        WHEN 'trialing'  THEN 1
        WHEN 'past_due'  THEN 2
        WHEN 'congelada' THEN 3
      END,
      m.created_at DESC
    LIMIT 1
    FOR UPDATE OF m;

    IF v_mem_id IS NULL THEN
      RAISE EXCEPTION 'SIN_MEMBRESIA: No tenés una membresía activa';
    END IF;

    IF v_mem_status = 'congelada' THEN
      RAISE EXCEPTION 'MEMBRESIA_CONGELADA: Tu membresía está pausada';
    END IF;

    IF v_mem_fin IS NOT NULL AND v_mem_fin <= v_now THEN
      RAISE EXCEPTION 'MEMBRESIA_VENCIDA: Tu membresía venció el %',
        to_char(v_mem_fin AT TIME ZONE v_tz, 'DD/MM/YYYY');
    END IF;
  END IF;

  IF v_es_socio THEN
    IF NOT _sala_permite_tier(v_recurso.tiers_permitidos, v_usuario.membresia_tier) THEN
      RAISE EXCEPTION 'TIER_NO_PERMITIDO: Tu plan no tiene acceso a esta sala';
    END IF;
  END IF;

  IF v_es_socio AND NOT COALESCE(v_tier_todas_sedes, true)
     AND v_mem_sucursal IS NOT NULL AND v_clase.sucursal_id IS NOT NULL
     AND v_mem_sucursal <> v_clase.sucursal_id THEN
    RAISE EXCEPTION 'SUCURSAL_NO_INCLUIDA: Tu plan solo cubre tu sede';
  END IF;

  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;

  IF v_es_socio AND p_invitados > 0 THEN
    IF COALESCE(v_inv_incluidos, 0) = 0 THEN
      RAISE EXCEPTION 'INVITADOS_NO_INCLUIDOS: Tu plan no incluye pases de invitado';
    END IF;

    v_ventana_inicio := COALESCE(v_mem_inicio, date_trunc('month', v_now));
    v_ventana_fin    := COALESCE(v_mem_fin, v_ventana_inicio + interval '1 month');

    SELECT COALESCE(SUM(r.invitados_count), 0)
    INTO v_inv_usados
    FROM reservas r
    WHERE r.usuario_id = v_user_id
      AND r.status IN ('confirmada', 'completada', 'no_show')
      AND r.created_at >= v_ventana_inicio
      AND r.created_at <  v_ventana_fin;

    v_inv_disponibles := GREATEST(v_inv_incluidos - COALESCE(v_inv_usados, 0), 0);

    IF p_invitados > v_inv_disponibles THEN
      RAISE EXCEPTION
        'INVITADOS_EXCEDEN: Tu plan incluye % pase(s) de invitado por periodo y te quedan %',
        v_inv_incluidos, v_inv_disponibles;
    END IF;
  END IF;

  v_costo := 1 + p_invitados;
  IF v_es_socio AND v_tier_tipo IN ('creditos', 'hibrido')
     AND COALESCE(v_mem_creditos, 0) < v_costo THEN
    RAISE EXCEPTION 'SIN_CREDITOS: Necesitás % crédito(s) (vos + % invitado(s)) y te quedan %',
      v_costo, p_invitados, COALESCE(v_mem_creditos, 0);
  END IF;

  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  v_slot_fin    := v_slot_inicio + (v_clase.duracion_minutos || ' minutes')::interval;

  IF v_es_socio AND NOT COALESCE(v_es_pase, false) AND v_mem_fin IS NOT NULL
     AND (v_slot_inicio AT TIME ZONE v_tz)::date > (v_mem_fin AT TIME ZONE v_tz)::date THEN
    RAISE EXCEPTION 'CLASE_FUERA_DE_VIGENCIA: Esa clase es posterior al vencimiento de tu plan (%). Renueva para reservarla.',
      to_char(v_mem_fin AT TIME ZONE v_tz, 'DD/MM/YYYY');
  END IF;

  v_min_anticipacion_min := COALESCE(
    (v_tenant.config->'reserva'->>'anticipacion_min_minutos')::integer,
    (v_tenant.config->'reserva'->>'anticipacion_min_horas')::integer * 60,
    (v_tenant.config->>'min_anticipacion_horas')::integer * 60,
    0);
  IF v_slot_inicio < v_now + (v_min_anticipacion_min || ' minutes')::interval THEN
    RAISE EXCEPTION 'ANTICIPACION_INSUFICIENTE: Debes reservar con al menos % minutos de anticipación', v_min_anticipacion_min;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE clase_id = p_clase_id
      AND usuario_id = v_user_id
      AND status IN ('confirmada','completada')
  ) INTO v_existe_doble;
  IF v_existe_doble THEN
    RAISE EXCEPTION 'YA_RESERVADO: Ya tenés una reserva activa en esta clase';
  END IF;

  v_permitir_continuas := COALESCE((v_tenant.config->'reserva'->>'permitir_continuas')::boolean, false);
  IF NOT v_permitir_continuas THEN
    SELECT EXISTS(
      SELECT 1 FROM reservas
      WHERE usuario_id = v_user_id
        AND status IN ('confirmada','completada')
        AND (slot_fin = v_slot_inicio OR slot_inicio = v_slot_fin)
    ) INTO v_existe_continua;
    IF v_existe_continua THEN
      RAISE EXCEPTION 'CONTINUA: No puedes reservar horas continuas';
    END IF;
  END IF;

  SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id
    AND status IN ('confirmada','completada');

  v_cupo_efectivo := CASE
    WHEN v_recurso.layout IS NOT NULL
      THEN COALESCE(jsonb_array_length(v_recurso.layout->'lugares'), v_clase.cupo_max)
    ELSE v_clase.cupo_max
  END;

  IF v_cupos_ocupados + 1 + p_invitados > v_cupo_efectivo THEN
    RAISE EXCEPTION 'CUPO_LLENO: Esta clase está llena (% / %)', v_cupos_ocupados, v_cupo_efectivo;
  END IF;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'SAL-' || lpad((v_folio_count + 1)::text, 6, '0');

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, notas,
    clase_id, lugar_id,
    membresia_id, entitlement_source
  ) VALUES (
    v_tenant_id, v_clase.recurso_id, v_user_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    p_invitados, 'confirmada', v_folio_nuevo, p_notas,
    p_clase_id, p_lugar_id,
    v_mem_id, v_entitlement_source
  )
  RETURNING id INTO v_reserva_id;

  IF v_recurso.layout IS NOT NULL AND v_con_detalle THEN
    INSERT INTO reserva_invitados (tenant_id, reserva_id, clase_id, nombre, telefono, email, lugar_id)
    SELECT v_tenant_id, v_reserva_id, p_clase_id,
           NULLIF(trim(e->>'nombre'), ''), NULLIF(trim(e->>'telefono'), ''),
           NULLIF(trim(e->>'email'), ''), e->>'lugar_id'
    FROM jsonb_array_elements(p_invitados_detalle) e;
  END IF;

  IF v_es_socio AND v_tier_tipo IN ('creditos', 'hibrido') THEN
    UPDATE membresias
    SET creditos_restantes = creditos_restantes - v_costo
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_tenant_id, 'debito', -v_costo,
      v_reserva_id,
      'reserva ' || v_folio_nuevo
        || CASE WHEN p_invitados > 0 THEN ' (+' || p_invitados || ' invitado(s))' ELSE '' END,
      v_user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo,
    'clase_id', p_clase_id,
    'lugar_id', p_lugar_id,
    'creditos_restantes', v_nuevo_creditos,
    'invitados_restantes', CASE
      WHEN v_es_socio AND COALESCE(v_inv_incluidos, 0) > 0
        THEN GREATEST(COALESCE(v_inv_disponibles, v_inv_incluidos) - p_invitados, 0)
      ELSE 0
    END
  );
END;
$function$;

-- ── 5) recepcion_crear_reserva: cuerpo VIGENTE (20261005260000) + SOLO el
--        asiento de invitado (con reserva padre activa) en el check LUGAR_OCUPADO.
--        Lock, guards de tenant/sede, validaciones y retorno sin cambios.
--        CREATE OR REPLACE conserva owner y GRANTs.
CREATE OR REPLACE FUNCTION public.recepcion_crear_reserva(p_usuario_id uuid, p_clase_id uuid DEFAULT NULL::uuid, p_horario_id uuid DEFAULT NULL::uuid, p_fecha date DEFAULT NULL::date, p_invitados integer DEFAULT 0, p_notas text DEFAULT NULL::text, p_lugar_id text DEFAULT NULL::text, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor_id uuid;
  v_tenant_id uuid;
  v_socio usuarios;
  v_clase clases;
  v_clase_id uuid;
  v_recurso recursos;
  v_now timestamptz := now();
  v_tz text;
  v_slot_inicio timestamptz;
  v_slot_fin timestamptz;
  v_cupos_ocupados integer;
  v_cupo_efectivo integer;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;

  v_mem_id uuid;
  v_mem_status text;
  v_mem_inicio timestamptz;
  v_mem_fin timestamptz;
  v_mem_creditos integer;
  v_tier_tipo text;
  v_tier_todas_sedes boolean;
  v_mem_sucursal uuid;
  v_nuevo_creditos integer;
  v_costo integer;

  v_inv_incluidos integer;
  v_inv_usados integer;
  v_inv_disponibles integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
BEGIN
  v_actor_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_actor_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden reservar por un socio';
  END IF;

  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE: El socio no existe';
  END IF;
  IF v_socio.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: El socio es de otro gimnasio';
  END IF;
  IF v_socio.rol <> 'miembro' THEN
    RAISE EXCEPTION 'ROL_INVALIDO: Solo se reserva para socios';
  END IF;

  v_clase_id := p_clase_id;
  IF v_clase_id IS NULL THEN
    IF p_horario_id IS NULL OR p_fecha IS NULL THEN
      RAISE EXCEPTION 'CLASE_REQUERIDA: Falta la clase (o el horario + fecha)';
    END IF;
    v_clase_id := materializar_clase(p_horario_id, p_fecha);
  END IF;

  SELECT * INTO v_clase FROM clases WHERE id = v_clase_id;
  IF v_clase IS NULL OR v_clase.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: Esta clase no existe en tu gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion(v_clase.sucursal_id);
  IF v_clase.status <> 'programada' THEN
    RAISE EXCEPTION 'CLASE_NO_PROGRAMADA: Esta clase no está disponible (status: %)', v_clase.status;
  END IF;

  v_tz := timezone_de_sucursal(v_clase.sucursal_id, v_clase.tenant_id);

  SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;
  IF v_recurso IS NULL OR NOT v_recurso.activo THEN
    RAISE EXCEPTION 'RECURSO_INACTIVO: Esta sala no está disponible';
  END IF;

  -- W2-01: serializa el cupo/asientos de ESTA clase (todas las salas), antes del
  -- check de lugar/cupo y antes del FOR UPDATE de la membresía. Mismo lock y orden
  -- que reservar_clase_atomic → sin deadlock. (Antes esta función no tenía lock.)
  PERFORM pg_advisory_xact_lock(hashtext('clase_lugares:' || v_clase_id::text));

  IF v_recurso.layout IS NOT NULL THEN
    IF p_invitados > 0 THEN
      RAISE EXCEPTION 'LUGAR_SIN_INVITADOS: En salas con lugar asignado, cada persona reserva su propio lugar';
    END IF;
    IF p_lugar_id IS NULL THEN
      RAISE EXCEPTION 'LUGAR_REQUERIDO: Elegí un lugar para esta clase';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') AS l
      WHERE l->>'id' = p_lugar_id
    ) THEN
      RAISE EXCEPTION 'LUGAR_INVALIDO: Ese lugar no existe en la sala';
    END IF;
    IF EXISTS (
      SELECT 1 FROM reservas
      WHERE clase_id = v_clase_id AND lugar_id = p_lugar_id
        AND status IN ('confirmada','completada')
    ) OR EXISTS (
      -- Ghost-seat fix: asiento de invitado, solo si su reserva padre está activa
      -- (misma regla que adjuntar_invitado / reservar_clase_atomic / lugares_ocupados).
      SELECT 1 FROM reserva_invitados ri JOIN reservas pr ON pr.id = ri.reserva_id
      WHERE ri.clase_id = v_clase_id AND ri.lugar_id = p_lugar_id
        AND pr.status IN ('confirmada','completada')
    ) THEN
      RAISE EXCEPTION 'LUGAR_OCUPADO: Ese lugar ya está tomado, elegí otro';
    END IF;
  ELSE
    p_lugar_id := NULL;
  END IF;

  IF v_socio.bloqueado_hasta IS NOT NULL AND v_socio.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: El socio tiene una restricción hasta el %',
      to_char(v_socio.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  SELECT m.id, m.status, m.periodo_actual_inicio, m.periodo_actual_fin,
         m.creditos_restantes, t.tipo, t.acceso_todas_sucursales, m.sucursal_id,
         COALESCE(t.invitados_por_periodo, 0)
  INTO v_mem_id, v_mem_status, v_mem_inicio, v_mem_fin,
       v_mem_creditos, v_tier_tipo, v_tier_todas_sedes, v_mem_sucursal,
       v_inv_incluidos
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
  ORDER BY
    CASE m.status
      WHEN 'activa'    THEN 0
      WHEN 'trialing'  THEN 1
      WHEN 'past_due'  THEN 2
      WHEN 'congelada' THEN 3
    END,
    m.created_at DESC
  LIMIT 1
  FOR UPDATE OF m;

  IF v_mem_id IS NULL THEN
    RAISE EXCEPTION 'SIN_MEMBRESIA: El socio no tiene una membresía activa';
  END IF;
  IF v_mem_status = 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_CONGELADA: La membresía del socio está pausada';
  END IF;
  IF v_mem_fin IS NOT NULL AND v_mem_fin <= v_now THEN
    RAISE EXCEPTION 'MEMBRESIA_VENCIDA: La membresía venció el %',
      to_char(v_mem_fin AT TIME ZONE v_tz, 'DD/MM/YYYY');
  END IF;

  IF NOT _sala_permite_tier(v_recurso.tiers_permitidos, v_socio.membresia_tier) THEN
    RAISE EXCEPTION 'TIER_NO_PERMITIDO: El plan del socio no da acceso a esta sala';
  END IF;

  IF NOT COALESCE(v_tier_todas_sedes, true)
     AND v_mem_sucursal IS NOT NULL AND v_clase.sucursal_id IS NOT NULL
     AND v_mem_sucursal <> v_clase.sucursal_id THEN
    RAISE EXCEPTION 'SUCURSAL_NO_INCLUIDA: El plan del socio solo cubre su sede';
  END IF;

  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;

  IF p_invitados > 0 THEN
    IF COALESCE(v_inv_incluidos, 0) = 0 THEN
      RAISE EXCEPTION 'INVITADOS_NO_INCLUIDOS: El plan del socio no incluye pases de invitado';
    END IF;

    v_ventana_inicio := COALESCE(v_mem_inicio, date_trunc('month', v_now));
    v_ventana_fin    := COALESCE(v_mem_fin, v_ventana_inicio + interval '1 month');

    SELECT COALESCE(SUM(r.invitados_count), 0)
    INTO v_inv_usados
    FROM reservas r
    WHERE r.usuario_id = p_usuario_id
      AND r.status IN ('confirmada', 'completada', 'no_show')
      AND r.created_at >= v_ventana_inicio
      AND r.created_at <  v_ventana_fin;

    v_inv_disponibles := GREATEST(v_inv_incluidos - COALESCE(v_inv_usados, 0), 0);

    IF p_invitados > v_inv_disponibles THEN
      RAISE EXCEPTION
        'INVITADOS_EXCEDEN: El plan incluye % pase(s) por periodo y le quedan %',
        v_inv_incluidos, v_inv_disponibles;
    END IF;
  END IF;

  v_costo := 1 + p_invitados;
  IF v_tier_tipo IN ('creditos', 'hibrido')
     AND COALESCE(v_mem_creditos, 0) < v_costo THEN
    RAISE EXCEPTION 'SIN_CREDITOS: Necesita % clase(s) y le quedan %',
      v_costo, COALESCE(v_mem_creditos, 0);
  END IF;

  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  v_slot_fin    := v_slot_inicio + (v_clase.duracion_minutos || ' minutes')::interval;

  IF EXISTS (
    SELECT 1 FROM reservas
    WHERE clase_id = v_clase_id
      AND usuario_id = p_usuario_id
      AND status IN ('confirmada','completada')
  ) THEN
    RAISE EXCEPTION 'YA_RESERVADO: El socio ya tiene una reserva en esta clase';
  END IF;

  SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = v_clase_id
    AND status IN ('confirmada','completada');

  v_cupo_efectivo := CASE
    WHEN v_recurso.layout IS NOT NULL
      THEN COALESCE(jsonb_array_length(v_recurso.layout->'lugares'), v_clase.cupo_max)
    ELSE v_clase.cupo_max
  END;

  IF v_cupos_ocupados + 1 + p_invitados > v_cupo_efectivo THEN
    RAISE EXCEPTION 'CUPO_LLENO: Esta clase está llena (% / %)', v_cupos_ocupados, v_cupo_efectivo;
  END IF;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'SAL-' || lpad((v_folio_count + 1)::text, 6, '0');

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, notas,
    clase_id, lugar_id,
    membresia_id, entitlement_source
  ) VALUES (
    v_tenant_id, v_clase.recurso_id, p_usuario_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    p_invitados, 'confirmada', v_folio_nuevo,
    COALESCE(NULLIF(trim(p_notas), ''), 'Walk-in en mostrador'),
    v_clase_id, p_lugar_id,
    -- #17A-1: esta ruta exige rol='miembro' con membresía validada más arriba
    -- (ROL_INVALIDO/SIN_MEMBRESIA abortan antes) → siempre 'membership'.
    v_mem_id, 'membership'
  )
  RETURNING id INTO v_reserva_id;

  IF v_tier_tipo IN ('creditos', 'hibrido') THEN
    UPDATE membresias
    SET creditos_restantes = creditos_restantes - v_costo
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_tenant_id, 'debito', -v_costo,
      v_reserva_id,
      'reserva ' || v_folio_nuevo || ' (mostrador)'
        || CASE WHEN p_invitados > 0 THEN ' (+' || p_invitados || ' invitado(s))' ELSE '' END,
      v_actor_id
    );
  END IF;

  PERFORM _audrec_log(
    'reserva.crear',
    'reserva',
    v_reserva_id,
    p_usuario_id,
    v_socio.nombre,
    format('Creó una reserva en el mostrador (%s). Motivo: %s',
           v_clase.nombre, COALESCE(NULLIF(trim(p_motivo), ''), 'walk-in')),
    jsonb_build_object(
      'clase_id', v_clase_id,
      'folio', v_folio_nuevo,
      'invitados', p_invitados,
      'motivo', p_motivo
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo,
    'clase_id', v_clase_id,
    'creditos_restantes', v_nuevo_creditos
  );
END;
$function$;

-- ── 6) cambiar_lugar_reserva: cuerpo VIGENTE (20261005260000) + lock de asientos
--        y relectura bajo lock + asiento de invitado activo en LUGAR_OCUPADO.
--        Auth/tenant/sede, errores y retorno sin cambios.
--        CREATE OR REPLACE conserva owner y GRANTs.
CREATE OR REPLACE FUNCTION public.cambiar_lugar_reserva(p_reserva_id uuid, p_lugar_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor_tenant uuid := get_my_tenant_id();
  v_reserva reservas;
  v_recurso recursos;
  v_clase_id uuid;
BEGIN
  IF v_actor_tenant IS NULL OR NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción/admin puede cambiar lugares';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;
  IF v_reserva.id IS NULL OR v_reserva.tenant_id <> v_actor_tenant THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe en tu gimnasio';
  END IF;
  -- #9 aislamiento por sede (recepción solo opera su sede).
  PERFORM _guard_sucursal_recepcion((SELECT c.sucursal_id FROM clases c WHERE c.id = v_reserva.clase_id));
  v_clase_id := v_reserva.clase_id;

  -- Orden de locks: fila de la reserva → advisory 'clase_lugares' (mismo orden
  -- que adjuntar_invitado y cancelar_reserva_atomic → sin ciclo nuevo). La fila
  -- bloqueada fija status/clase/recurso de ESTA reserva; el advisory serializa
  -- contra todo otro escritor de asientos de la clase.
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;
  IF v_reserva.id IS NULL OR v_reserva.tenant_id <> v_actor_tenant
     OR v_reserva.clase_id IS DISTINCT FROM v_clase_id THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe en tu gimnasio';
  END IF;
  -- (clase_id NULL = reserva sin clase: no hay asientos de clase que serializar;
  --  pg_advisory_xact_lock es STRICT y el check de ocupación no puede coincidir.)
  PERFORM pg_advisory_xact_lock(hashtext('clase_lugares:' || v_clase_id::text));

  -- Lectura AUTORITATIVA bajo ambos locks: todo lo que decide disponibilidad se
  -- lee desde aquí (nada de lo leído antes del lock se usa para decidir).
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;
  IF v_reserva.status NOT IN ('confirmada', 'completada') THEN
    RAISE EXCEPTION 'RESERVA_NO_ACTIVA: La reserva no está activa';
  END IF;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;
  IF v_recurso.layout IS NULL THEN
    RAISE EXCEPTION 'SALA_SIN_MAPA: Esta sala no usa Mapa de Salón';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_recurso.layout->'lugares') AS l
    WHERE l->>'id' = p_lugar_id
  ) THEN
    RAISE EXCEPTION 'LUGAR_INVALIDO: Ese lugar no existe en la sala';
  END IF;

  IF EXISTS (
    SELECT 1 FROM reservas
    WHERE clase_id = v_reserva.clase_id
      AND lugar_id = p_lugar_id
      AND status IN ('confirmada', 'completada')
      AND id <> p_reserva_id
  ) OR EXISTS (
    -- Ghost-seat fix: asiento de invitado, solo si su reserva padre está activa
    -- (misma regla que adjuntar_invitado / reservar_clase_atomic / recepcion_crear_reserva).
    SELECT 1 FROM reserva_invitados ri JOIN reservas pr ON pr.id = ri.reserva_id
    WHERE ri.clase_id = v_reserva.clase_id AND ri.lugar_id = p_lugar_id
      AND pr.status IN ('confirmada','completada')
  ) THEN
    RAISE EXCEPTION 'LUGAR_OCUPADO: Ese lugar ya está tomado';
  END IF;

  UPDATE reservas
  SET lugar_id = p_lugar_id, updated_at = now()
  WHERE id = p_reserva_id;

  RETURN jsonb_build_object('success', true, 'reserva_id', p_reserva_id, 'lugar_id', p_lugar_id);
END;
$function$;

-- ════════════════════════════════════════════════════════════════════════════
-- SELF-TEST (devuelve TABLA). Diagnóstico puro: crea un gym desechable, corre
-- los casos y REVIERTE TODO con una excepción centinela antes de devolver las
-- filas (los resultados viven en variables, que no se revierten). No deja
-- residuo; la última fila lo verifica. Se borra a sí mismo al final.
-- Corre como el dueño de la migración (salta RLS): prueba las RPCs y los
-- privilegios/policies; el enforcement de RLS con rol authenticated se prueba
-- aparte (sandbox).
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _diag_invitados_attach_only()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_slug text := 'zz-g1att-' || substr(md5(random()::text), 1, 6);
  v_p text[] := ARRAY[]::text[];
  v_r text[] := ARRAY[]::text[];
  v_t uuid; v_sa uuid; v_sb uuid; v_tier uuid;
  v_rec uuid; v_rec_b uuid; v_rec_map uuid;
  a_m1 uuid := gen_random_uuid(); a_m2 uuid := gen_random_uuid(); a_rec uuid := gen_random_uuid();
  u_m1 uuid; u_m2 uuid; v_mem1 uuid; v_mem2 uuid;
  v_c uuid; v_c_b uuid; v_c_map uuid; v_c_past uuid;
  v_r1 uuid; v_rb uuid; v_ra uuid; v_rx uuid; v_rpast uuid; v_rmap uuid; v_rm1 uuid; v_rm2 uuid;
  k1 uuid := gen_random_uuid();
  v_res jsonb; v_err text; v_n int; v_cnt int; v_cred int; v_cred0 int; v_ocup int; v_ocup0 int;
  v_ok boolean; i int;
BEGIN
  BEGIN
    INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug, 'G1 Attach', 'gym_libre', 'activo') RETURNING id INTO v_t;
    INSERT INTO sucursales (tenant_id, nombre, orden) VALUES (v_t, 'Sede A', 90) RETURNING id INTO v_sa;
    INSERT INTO sucursales (tenant_id, nombre, orden) VALUES (v_t, 'Sede B', 91) RETURNING id INTO v_sb;
    INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, clases_incluidas, periodo, activo, invitados_por_periodo)
      VALUES (v_t, 'g1-paq', 'Paquete', 100000, 'creditos', 20, 'mensual', true, 6) RETURNING id INTO v_tier;
    INSERT INTO recursos (tenant_id, slug, nombre, sucursal_id, tipo, cupo_max_default)
      VALUES (v_t, 'g1-sala', 'Sala', v_sa, 'sala_grupal', 10) RETURNING id INTO v_rec;
    INSERT INTO recursos (tenant_id, slug, nombre, sucursal_id, tipo, cupo_max_default)
      VALUES (v_t, 'g1-sala-b', 'Sala B', v_sb, 'sala_grupal', 10) RETURNING id INTO v_rec_b;
    INSERT INTO recursos (tenant_id, slug, nombre, sucursal_id, tipo, cupo_max_default, layout)
      VALUES (v_t, 'g1-mapa', 'Mapa', v_sa, 'sala_grupal', 6,
              jsonb_build_object('lugares', (SELECT jsonb_agg(jsonb_build_object('id', 'L'||g)) FROM generate_series(1,6) g)))
      RETURNING id INTO v_rec_map;

    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
    VALUES (a_m1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_slug||'-m1@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'M1'), '', now(), now(), now()),
           (a_m2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_slug||'-m2@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'M2'), '', now(), now(), now()),
           (a_rec,'00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_slug||'-ra@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'RecepA'), '', now(), now(), now());
    UPDATE usuarios SET rol = 'miembro', status = 'activo', sucursal_id = v_sa, membresia_tier = 'g1-paq' WHERE auth_id IN (a_m1, a_m2);
    UPDATE usuarios SET rol = 'recepcionista', status = 'activo', sucursal_id = v_sa WHERE auth_id = a_rec;
    SELECT id INTO u_m1 FROM usuarios WHERE auth_id = a_m1;
    SELECT id INTO u_m2 FROM usuarios WHERE auth_id = a_m2;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, sucursal_id, creditos_restantes, periodo_actual_inicio, periodo_actual_fin)
      VALUES (v_t, u_m1, v_tier, 'activa', v_sa, 20, now() - interval '1 day', now() + interval '60 days') RETURNING id INTO v_mem1;
    INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, sucursal_id, creditos_restantes, periodo_actual_inicio, periodo_actual_fin)
      VALUES (v_t, u_m2, v_tier, 'activa', v_sa, 20, now() - interval '1 day', now() + interval '60 days') RETURNING id INTO v_mem2;

    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_sa, CURRENT_DATE + 10, '10:00', 60, 'G1 C', 10, 'programada') RETURNING id INTO v_c;
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec_b, v_sb, CURRENT_DATE + 10, '12:00', 60, 'G1 CB', 10, 'programada') RETURNING id INTO v_c_b;
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec_map, v_sa, CURRENT_DATE + 10, '14:00', 60, 'G1 MAPA', 6, 'programada') RETURNING id INTO v_c_map;
    INSERT INTO clases (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre, cupo_max, status)
      VALUES (v_t, v_rec, v_sa, CURRENT_DATE - 2, '10:00', 60, 'G1 PASADA', 10, 'programada') RETURNING id INTO v_c_past;

    -- ── Reserva real del socio con 2 invitados (ruta normal de reservar) ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m1::text)::text, true);
    v_res := reservar_clase_atomic(v_c, 2, NULL, NULL, NULL);
    v_r1 := (v_res->>'reserva_id')::uuid;
    SELECT creditos_restantes INTO v_cred0 FROM membresias WHERE id = v_mem1;
    SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_ocup0 FROM reservas WHERE clase_id = v_c AND status IN ('confirmada','completada');
    v_p := v_p || 'T0. reservar con 2 invitados cobra UNA vez (20→17 créditos, ocupación 3)'::text;
    v_r := v_r || CASE WHEN v_cred0 = 17 AND v_ocup0 = 3 THEN '✅ ok' ELSE '❌ créditos='||v_cred0||' ocupación='||v_ocup0 END;

    -- T1/T2: adjuntar 2 de 2
    v_err := NULL;
    BEGIN
      PERFORM adjuntar_invitado(v_r1, 'Ana', '555-1', NULL, NULL, k1);
      PERFORM adjuntar_invitado(v_r1, 'Beto', NULL, 'beto@x.dev', NULL, NULL);
    EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    SELECT count(*) INTO v_n FROM reserva_invitados WHERE reserva_id = v_r1;
    v_p := v_p || 'T1. socio adjunta 2 identidades a su reserva de 2 invitados → ALLOW'::text;
    v_r := v_r || CASE WHEN v_err IS NULL AND v_n = 2 THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'-')||' filas='||v_n END;

    -- T2: el 3º se rechaza y nada económico cambia
    v_err := NULL;
    BEGIN PERFORM adjuntar_invitado(v_r1, 'Caro', '555-3', NULL, NULL, NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    SELECT count(*) INTO v_n FROM reserva_invitados WHERE reserva_id = v_r1;
    SELECT invitados_count INTO v_cnt FROM reservas WHERE id = v_r1;
    SELECT creditos_restantes INTO v_cred FROM membresias WHERE id = v_mem1;
    SELECT COALESCE(SUM(1 + invitados_count), 0) INTO v_ocup FROM reservas WHERE clase_id = v_c AND status IN ('confirmada','completada');
    v_p := v_p || 'T2. 3er adjunto → INVITADOS_COMPLETOS; invitados_count=2, créditos 17, ocupación 3 sin cambio'::text;
    v_r := v_r || CASE WHEN v_err LIKE 'INVITADOS_COMPLETOS%' AND v_n = 2 AND v_cnt = 2 AND v_cred = 17 AND v_ocup = 3
      THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)')||' filas='||v_n||' count='||v_cnt||' cred='||v_cred||' ocup='||v_ocup END;

    -- T3: replay misma key + mismo payload → already_processed, sin fila nueva
    v_res := adjuntar_invitado(v_r1, 'Ana', '555-1', NULL, NULL, k1);
    SELECT count(*) INTO v_n FROM reserva_invitados WHERE reserva_id = v_r1;
    v_p := v_p || 'T3. reintento misma key/payload → already_processed, 2 filas'::text;
    v_r := v_r || CASE WHEN v_res->>'status' = 'already_processed' AND v_n = 2 THEN '✅ ok' ELSE '❌ res='||v_res::text||' filas='||v_n END;

    -- T4: misma key, payload distinto → IDEMPOTENCY_CONFLICT
    v_err := NULL;
    BEGIN PERFORM adjuntar_invitado(v_r1, 'Otra', '555-9', NULL, NULL, k1); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_p := v_p || 'T4. misma key, payload distinto → IDEMPOTENCY_CONFLICT'::text;
    v_r := v_r || CASE WHEN v_err LIKE 'IDEMPOTENCY_CONFLICT%' THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)') END;

    -- T5: otro socio sobre una reserva ajena → NO_AUTORIZADO
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id, entitlement_source)
      VALUES (v_t, v_rec, u_m1, now() + interval '10 days', now() + interval '10 days 1 hour', 60, 1, 'confirmada', v_slug||'-x', v_c, 'staff_benefit')
      RETURNING id INTO v_rx;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m2::text)::text, true);
    v_err := NULL;
    BEGIN PERFORM adjuntar_invitado(v_rx, 'Squat', NULL, NULL, NULL, NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    SELECT count(*) INTO v_n FROM reserva_invitados WHERE reserva_id = v_rx;
    v_p := v_p || 'T5. socio adjunta en reserva AJENA → NO_AUTORIZADO, 0 filas'::text;
    v_r := v_r || CASE WHEN v_err LIKE 'NO_AUTORIZADO%' AND v_n = 0 THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)')||' filas='||v_n END;

    -- T6: reserva cancelada / clase pasada → bloqueadas
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id, entitlement_source)
      VALUES (v_t, v_rec, u_m2, now() + interval '10 days', now() + interval '10 days 1 hour', 60, 1, 'cancelada', v_slug||'-can', v_c, 'staff_benefit')
      RETURNING id INTO v_ra;
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id, entitlement_source)
      VALUES (v_t, v_rec, u_m2, now() - interval '2 days', now() - interval '2 days' + interval '1 hour', 60, 1, 'confirmada', v_slug||'-past', v_c_past, 'staff_benefit')
      RETURNING id INTO v_rpast;
    v_err := NULL;
    BEGIN PERFORM adjuntar_invitado(v_ra, 'X', NULL, NULL, NULL, NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_ok := v_err LIKE 'RESERVA_NO_ACTIVA%';
    v_err := NULL;
    BEGIN PERFORM adjuntar_invitado(v_rpast, 'X', NULL, NULL, NULL, NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_p := v_p || 'T6. reserva cancelada → RESERVA_NO_ACTIVA; clase pasada → RESERVA_PASADA'::text;
    v_r := v_r || CASE WHEN v_ok AND v_err LIKE 'RESERVA_PASADA%' THEN '✅ ok' ELSE '❌ cancelada_ok='||v_ok||' pasada_err='||coalesce(v_err,'(ninguno)') END;

    -- T7: recepción sede A → reserva de sede B bloqueada; sede A con contacto ALLOW (crea ficha)
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id, entitlement_source)
      VALUES (v_t, v_rec_b, u_m2, now() + interval '10 days', now() + interval '10 days 1 hour', 60, 1, 'confirmada', v_slug||'-b', v_c_b, 'staff_benefit')
      RETURNING id INTO v_rb;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_rec::text)::text, true);
    v_err := NULL;
    BEGIN PERFORM recepcion_agregar_invitado(v_rb, 'Gina', '555-7', NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    SELECT count(*) INTO v_n FROM reserva_invitados WHERE reserva_id = v_rb;
    v_p := v_p || 'T7a. recepción sede A agrega invitado en reserva de sede B → SUCURSAL_DIFERENTE, 0 filas'::text;
    v_r := v_r || CASE WHEN v_err LIKE 'SUCURSAL_DIFERENTE%' AND v_n = 0 THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)')||' filas='||v_n END;

    v_err := NULL;
    BEGIN PERFORM recepcion_agregar_invitado(v_rx, 'SinContacto', NULL, NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_ok := v_err LIKE 'CONTACTO_REQUERIDO%';
    v_err := NULL;
    BEGIN v_res := recepcion_agregar_invitado(v_rx, 'Hugo', '555-8', NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    SELECT count(*) INTO v_n FROM reserva_invitados WHERE reserva_id = v_rx AND usuario_id IS NOT NULL;
    v_p := v_p || 'T7b. recepción sede A: sin contacto → CONTACTO_REQUERIDO; con teléfono → ALLOW + ficha de socio creada'::text;
    v_r := v_r || CASE WHEN v_ok AND v_err IS NULL AND (v_res->>'creado')::boolean AND v_n = 1 THEN '✅ ok' ELSE '❌ contacto_ok='||v_ok||' err='||coalesce(v_err,'-')||' filas='||v_n END;

    v_err := NULL;
    BEGIN PERFORM recepcion_agregar_invitado(v_rx, 'Iris', '555-10', NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    SELECT invitados_count INTO v_cnt FROM reservas WHERE id = v_rx;
    v_p := v_p || 'T7c. recepción tampoco pasa el conteo (1/1) → INVITADOS_COMPLETOS, invitados_count sigue 1'::text;
    v_r := v_r || CASE WHEN v_err LIKE 'INVITADOS_COMPLETOS%' AND v_cnt = 1 THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)')||' count='||v_cnt END;

    -- T8: sala con mapa (Diseño A)
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio, clase_id, entitlement_source, lugar_id)
      VALUES (v_t, v_rec_map, u_m1, now() + interval '10 days', now() + interval '10 days 1 hour', 60, 1, 'confirmada', v_slug||'-map', v_c_map, 'staff_benefit', 'L1')
      RETURNING id INTO v_rmap;
    v_err := NULL;
    BEGIN PERFORM recepcion_agregar_invitado(v_rmap, 'Mapa', '555-11', NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_p := v_p || 'T8a. recepción en sala con mapa → LUGAR_SIN_INVITADOS (Q7)'::text;
    v_r := v_r || CASE WHEN v_err LIKE 'LUGAR_SIN_INVITADOS%' THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'(ninguno)') END;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m1::text)::text, true);
    v_err := NULL;
    BEGIN PERFORM adjuntar_invitado(v_rmap, 'G', NULL, NULL, NULL, NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_ok := v_err LIKE 'LUGAR_REQUERIDO%';
    v_err := NULL;
    BEGIN PERFORM adjuntar_invitado(v_rmap, 'G', NULL, NULL, 'L1', NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_ok := v_ok AND v_err LIKE 'LUGAR_OCUPADO%';
    v_err := NULL;
    BEGIN PERFORM adjuntar_invitado(v_rmap, 'G', NULL, NULL, 'L99', NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_ok := v_ok AND v_err LIKE 'LUGAR_INVALIDO%';
    SELECT count(*) INTO v_n FROM reserva_invitados WHERE reserva_id = v_rmap;
    v_p := v_p || 'T8b. mapa: sin lugar → LUGAR_REQUERIDO; ocupado → LUGAR_OCUPADO; inexistente → LUGAR_INVALIDO; 0 filas'::text;
    v_r := v_r || CASE WHEN v_ok AND v_n = 0 THEN '✅ ok' ELSE '❌ ok='||coalesce(v_ok::text,'null')||' último='||coalesce(v_err,'-')||' filas='||v_n END;

    v_err := NULL;
    BEGIN PERFORM adjuntar_invitado(v_rmap, 'G', NULL, NULL, 'L2', NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    SELECT count(*) INTO v_n FROM lugares_ocupados(v_c_map) WHERE lugar_id IN ('L1','L2');
    v_p := v_p || 'T8c. mapa: lugar libre L2 → ALLOW; lugares_ocupados muestra L1+L2'::text;
    v_r := v_r || CASE WHEN v_err IS NULL AND v_n = 2 THEN '✅ ok' ELSE '❌ err='||coalesce(v_err,'-')||' ocupados='||v_n END;

    -- T9: ghost-seat — cancelar la reserva padre libera el asiento del invitado
    v_res := cancelar_reserva_atomic(v_rmap, 'g1 ghost');
    SELECT count(*) INTO v_n FROM lugares_ocupados(v_c_map) WHERE lugar_id IN ('L1','L2');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m2::text)::text, true);
    v_err := NULL;
    BEGIN PERFORM reservar_clase_atomic(v_c_map, 1, NULL, 'L1', jsonb_build_array(jsonb_build_object('nombre','Nuevo','lugar_id','L2'))); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_p := v_p || 'T9. ghost-seat: cancelar padre → L1/L2 libres al instante; nueva reserva real toma L1 + invitado en L2'::text;
    v_r := v_r || CASE WHEN v_n = 0 AND v_err IS NULL THEN '✅ ok' ELSE '❌ ocupados_tras_cancelar='||v_n||' err='||coalesce(v_err,'-') END;

    -- T11: recepción no sienta a un socio sobre el asiento de un invitado activo
    --      (tras T9: m2 tiene L1 + invitado en L2); al cancelar el padre, L2 se libera.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_rec::text)::text, true);
    v_err := NULL;
    BEGIN PERFORM recepcion_crear_reserva(u_m1, v_c_map, NULL, NULL, 0, NULL, 'L2', 'g1'); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_ok := v_err LIKE 'LUGAR_OCUPADO%';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m2::text)::text, true);
    PERFORM cancelar_reserva_atomic((SELECT id FROM reservas WHERE clase_id = v_c_map AND usuario_id = u_m2 AND status = 'confirmada'), 'g1 t11');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_rec::text)::text, true);
    v_err := NULL;
    BEGIN PERFORM recepcion_crear_reserva(u_m1, v_c_map, NULL, NULL, 0, NULL, 'L2', 'g1'); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    SELECT count(*) INTO v_n FROM reservas WHERE clase_id = v_c_map AND usuario_id = u_m1 AND lugar_id = 'L2' AND status = 'confirmada';
    v_p := v_p || 'T11. recepción sobre asiento de invitado activo (L2) → LUGAR_OCUPADO; padre cancelado → recepción toma L2'::text;
    v_r := v_r || CASE WHEN v_ok AND v_err IS NULL AND v_n = 1 THEN '✅ ok' ELSE '❌ ocupado_ok='||coalesce(v_ok::text,'null')||' err='||coalesce(v_err,'-')||' filas='||v_n END;

    -- T12: cambiar_lugar_reserva no mueve a un socio sobre el asiento de un invitado
    --      activo ni sobre el de otro socio; al cancelar el padre, el asiento se libera.
    --      (tras T11: m1 está en L2.) m2 reserva L3 + invitado en L4.
    v_rm1 := (SELECT id FROM reservas WHERE clase_id = v_c_map AND usuario_id = u_m1 AND status = 'confirmada');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m2::text)::text, true);
    v_res := reservar_clase_atomic(v_c_map, 1, NULL, 'L3', jsonb_build_array(jsonb_build_object('nombre','G12','lugar_id','L4')));
    v_rm2 := (v_res->>'reserva_id')::uuid;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_rec::text)::text, true);
    v_err := NULL;
    BEGIN PERFORM cambiar_lugar_reserva(v_rm1, 'L4'); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_ok := v_err LIKE 'LUGAR_OCUPADO%';
    v_err := NULL;
    BEGIN PERFORM cambiar_lugar_reserva(v_rm1, 'L3'); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    v_ok := v_ok AND v_err LIKE 'LUGAR_OCUPADO%';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_m2::text)::text, true);
    PERFORM cancelar_reserva_atomic(v_rm2, 'g1 t12');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a_rec::text)::text, true);
    v_err := NULL;
    BEGIN v_res := cambiar_lugar_reserva(v_rm1, 'L4'); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
    SELECT count(*) INTO v_n FROM reservas WHERE id = v_rm1 AND lugar_id = 'L4' AND status = 'confirmada';
    v_p := v_p || 'T12. cambiar_lugar: sobre invitado activo (L4) y sobre socio (L3) → LUGAR_OCUPADO; padre cancelado → mueve a L4'::text;
    v_r := v_r || CASE WHEN v_ok AND v_err IS NULL AND v_n = 1 THEN '✅ ok' ELSE '❌ ocupado_ok='||coalesce(v_ok::text,'null')||' err='||coalesce(v_err,'-')||' filas='||v_n END;

    -- T10: privilegios / policies de escritura directa
    v_p := v_p || 'T10. authenticated/anon sin INSERT/UPDATE/DELETE/TRUNCATE; SELECT intacto; sin policies permisivas de escritura'::text;
    v_r := v_r || CASE WHEN
         NOT has_table_privilege('authenticated', 'reserva_invitados', 'INSERT')
     AND NOT has_table_privilege('authenticated', 'reserva_invitados', 'UPDATE')
     AND NOT has_table_privilege('authenticated', 'reserva_invitados', 'DELETE')
     AND NOT has_table_privilege('authenticated', 'reserva_invitados', 'TRUNCATE')
     AND NOT has_table_privilege('anon', 'reserva_invitados', 'TRUNCATE')
     AND has_table_privilege('authenticated', 'reserva_invitados', 'SELECT')
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'reserva_invitados'
                     AND cmd IN ('INSERT','UPDATE','DELETE','ALL') AND permissive = 'PERMISSIVE')
      THEN '✅ ok' ELSE '❌ privilegios/policies' END;

    RAISE EXCEPTION 'G1_DIAG_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'G1_DIAG_ROLLBACK' THEN
      v_p := v_p || 'ERROR inesperado'::text;
      v_r := v_r || ('❌ '||SQLERRM);
    END IF;
  END;

  v_p := v_p || 'Z. sin residuo (todo revertido)'::text;
  v_r := v_r || CASE WHEN NOT EXISTS (SELECT 1 FROM tenants WHERE slug = v_slug)
                      AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id IN (a_m1, a_m2, a_rec))
                      AND NOT EXISTS (SELECT 1 FROM business_operations WHERE operation_key = k1)
                 THEN '✅ ok' ELSE '❌ quedaron fixtures de '||v_slug END;

  FOR i IN 1..array_length(v_p, 1) LOOP
    prueba := v_p[i]; resultado := v_r[i];
    RETURN NEXT;
  END LOOP;
END $$;

SELECT * FROM _diag_invitados_attach_only();
DROP FUNCTION _diag_invitados_attach_only();

COMMIT;
