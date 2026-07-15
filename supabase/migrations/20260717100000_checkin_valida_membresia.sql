-- ============================================================================
-- CHECK-IN: revalidar la membresía en la puerta (no solo al reservar)
-- ----------------------------------------------------------------------------
-- EL HUECO: el gate de membresía (vencida / congelada / sin membresía) vivía
-- SOLO en la reserva. El check-in confiaba en que una reserva 'confirmada' seguía
-- siendo válida. Pero la membresía puede morir ENTRE la reserva y la clase:
--   · un socio reserva el lunes al día, su mensualidad vence el miércoles, llega
--     el jueves y entra igual;
--   · le congelan la membresía después de reservar, y entra lo mismo.
-- Las tres vías de check-in (QR, manual, huella) marcaban entrada sin mirar
-- `membresias`. Este archivo cierra eso.
--
-- POLÍTICA (decidida con el dueño): "recepción ve y decide".
--   · QR y HUELLA (automáticas, sin humano que juzgue) BLOQUEAN si la membresía
--     no está viva. El socio no entra solo con una membresía muerta.
--   · MANUAL (la recepcionista, con criterio) NO bloquea: deja marcar entrada,
--     pero la respuesta trae el estado de la membresía para que la pantalla lo
--     muestre en rojo y ella cobre o decida. Ni regala ni humilla en la puerta.
--
-- Un detalle que justifica no bloquear en créditos: el crédito ya se gastó al
-- reservar. Bloquear ahí sería quitarle el crédito Y no dejarlo entrar. Por eso
-- el estado que importa acá es la VIDA de la membresía (status + vencimiento),
-- no el saldo de créditos: para ESA clase ya pagó.
--
-- La lógica de "membresía viva" se copia EXACTA del gate de reserva
-- (20260715130000): mismos estados, mismo orden de prioridad, mismo criterio de
-- vencimiento. Vive en UN helper para que las dos definiciones no diverjan.
--
-- Y como recrear estas funciones a mano ya perdió guards 4 veces, el guard nuevo
-- vive en su propia función, las vías automáticas la LLAMAN, y el test de
-- contrato al final falla la migración si alguna dejó de llamarla (igual que ya
-- hacemos con el guard de sucursal).
-- ============================================================================

-- ── El estado de la membresía para el check-in, en un solo lugar ────────────
-- Devuelve: 'ok' | 'sin_membresia' | 'congelada' | 'vencida'.
-- Mismo SELECT y mismo orden de prioridad que reservar_clase_atomic.
CREATE OR REPLACE FUNCTION _estado_membresia_checkin(p_usuario_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rol text;
  v_status text;
  v_fin timestamptz;
BEGIN
  SELECT rol INTO v_rol FROM usuarios WHERE id = p_usuario_id;

  -- Solo los socios tienen membresía que pueda estar muerta. Un admin/staff que
  -- reservó para sí mismo no se bloquea (igual que v_es_socio en el gate).
  IF v_rol IS DISTINCT FROM 'miembro' THEN
    RETURN 'ok';
  END IF;

  SELECT m.status, m.periodo_actual_fin
  INTO v_status, v_fin
  FROM membresias m
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
  LIMIT 1;

  IF v_status IS NULL THEN
    RETURN 'sin_membresia';
  END IF;

  IF v_status = 'congelada' THEN
    RETURN 'congelada';
  END IF;

  IF v_fin IS NOT NULL AND v_fin <= now() THEN
    RETURN 'vencida';
  END IF;

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION _estado_membresia_checkin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION _estado_membresia_checkin(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION _estado_membresia_checkin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION _estado_membresia_checkin(uuid) TO service_role;


-- ── El guard que usan las vías automáticas (QR y huella) ────────────────────
CREATE OR REPLACE FUNCTION _guard_membresia_checkin(p_usuario_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_estado text := _estado_membresia_checkin(p_usuario_id);
BEGIN
  IF v_estado = 'sin_membresia' THEN
    RAISE EXCEPTION 'SIN_MEMBRESIA: El socio no tiene una membresía activa';
  ELSIF v_estado = 'congelada' THEN
    RAISE EXCEPTION 'MEMBRESIA_CONGELADA: La membresía del socio está pausada';
  ELSIF v_estado = 'vencida' THEN
    RAISE EXCEPTION 'MEMBRESIA_VENCIDA: La membresía del socio venció';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION _guard_membresia_checkin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION _guard_membresia_checkin(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION _guard_membresia_checkin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION _guard_membresia_checkin(uuid) TO service_role;


-- ── 1) Check-in por QR — ahora BLOQUEA membresía muerta ─────────────────────
CREATE OR REPLACE FUNCTION check_in_atomic(p_reserva_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_rol text;
  v_reserva reservas;
  v_miembro usuarios;
  v_recurso recursos;
  v_now timestamptz := now();
  v_ventana_min integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
  v_check_ins_hoy integer;
  v_check_ins_semana integer;
  v_inicio_semana timestamptz;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();
  v_rol := get_my_rol();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  IF v_rol NOT IN ('admin', 'recepcionista', 'staff') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff puede hacer check-in';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  PERFORM _guard_sucursal_staff(v_reserva.recurso_id);

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este miembro ya hizo check-in (% UTC)', v_reserva.check_in_at;
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'RESERVA_CANCELADA: Esta reserva fue cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'RESERVA_NO_SHOW: Esta reserva fue marcada como inasistencia';
  END IF;

  -- LA PUERTA NUEVA: el QR es automático, así que bloquea. Si la membresía murió
  -- entre la reserva y ahora, no entra solo. (Manual sí puede, con criterio.)
  PERFORM _guard_membresia_checkin(v_reserva.usuario_id);

  -- La ventana la decide el GYM (Ajustes → Reglas), no el código.
  v_ventana_min := ventana_check_in_min(v_tenant_id);
  v_ventana_inicio := v_reserva.slot_inicio - (v_ventana_min || ' minutes')::interval;
  v_ventana_fin := v_reserva.slot_fin + (v_ventana_min * 2 || ' minutes')::interval;

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'DEMASIADO_TEMPRANO: El check-in abre % min antes (a las %)',
      v_ventana_min, to_char(v_ventana_inicio, 'HH24:MI');
  END IF;

  IF v_now > v_ventana_fin THEN
    RAISE EXCEPTION 'DEMASIADO_TARDE: El check-in cerró a las %',
      to_char(v_ventana_fin, 'HH24:MI');
  END IF;

  UPDATE reservas
  SET status = 'completada',
      check_in_at = v_now,
      check_in_by = v_user_id,
      check_in_method = 'qr'
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;
  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;

  v_inicio_semana := date_trunc('week', v_now);

  SELECT count(*) INTO v_check_ins_hoy
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= date_trunc('day', v_now);

  SELECT count(*) INTO v_check_ins_semana
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= v_inicio_semana;

  IF v_rol IN ('recepcionista', 'admin') THEN
    PERFORM _audrec_log(
      'checkin.qr', 'reserva', p_reserva_id, v_reserva.usuario_id, v_miembro.nombre,
      format('Check-in QR de %s', to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI')),
      jsonb_build_object('method', 'qr')
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva', row_to_json(v_reserva),
    'miembro', jsonb_build_object(
      'id', v_miembro.id,
      'nombre', v_miembro.nombre,
      'email', v_miembro.email,
      'telefono', v_miembro.telefono,
      'avatar_url', v_miembro.avatar_url,
      'membresia_tier', v_miembro.membresia_tier,
      'notas_admin', v_miembro.notas_admin
    ),
    'recurso', jsonb_build_object(
      'id', v_recurso.id,
      'nombre', v_recurso.nombre
    ),
    -- Por QR siempre será 'ok' (si no, ya habría reventado arriba), pero lo
    -- mandamos igual para que la pantalla no tenga que adivinar.
    'membresia_estado', _estado_membresia_checkin(v_reserva.usuario_id),
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;


-- ── 2) Check-in manual — NO bloquea, pero avisa ─────────────────────────────
-- La recepcionista decide. Le devolvemos el estado para que la pantalla lo pinte
-- en rojo si la membresía está muerta, y ella cobre o deje pasar con criterio.
CREATE OR REPLACE FUNCTION check_in_manual_atomic(
  p_reserva_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_rol text;
  v_reserva reservas;
  v_miembro usuarios;
  v_recurso recursos;
  v_now timestamptz := now();
  v_ventana_min integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
  v_check_ins_hoy integer;
  v_check_ins_semana integer;
  v_inicio_semana timestamptz;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();
  v_rol := get_my_rol();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  IF v_rol NOT IN ('admin', 'recepcionista', 'staff') THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo staff puede hacer check-in';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  PERFORM _guard_sucursal_staff(v_reserva.recurso_id);

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este miembro ya hizo check-in';
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'RESERVA_CANCELADA: Reserva cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'RESERVA_NO_SHOW: Reserva marcada como inasistencia';
  END IF;

  -- OJO: acá NO bloqueamos por membresía. La manual es la vía de escape con
  -- criterio humano; bloquearla sería quitarle a la recepción justo la
  -- herramienta que la política le da. El estado viaja en la respuesta para que
  -- la pantalla lo muestre. (El test de contrato verifica esta ausencia.)

  v_ventana_min := ventana_check_in_min(v_tenant_id);
  v_ventana_inicio := v_reserva.slot_inicio - (v_ventana_min * 2 || ' minutes')::interval;
  v_ventana_fin := v_reserva.slot_fin + (v_ventana_min * 4 || ' minutes')::interval;

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'DEMASIADO_TEMPRANO: El check-in manual abre % min antes (a las %)',
      v_ventana_min * 2, to_char(v_ventana_inicio, 'HH24:MI');
  END IF;

  IF v_now > v_ventana_fin THEN
    RAISE EXCEPTION 'DEMASIADO_TARDE: El check-in manual cerró a las %',
      to_char(v_ventana_fin, 'HH24:MI');
  END IF;

  UPDATE reservas
  SET status = 'completada',
      check_in_at = v_now,
      check_in_by = v_user_id,
      check_in_method = 'manual',
      notas = COALESCE(notas, '') ||
              CASE WHEN p_motivo IS NOT NULL
                   THEN E'\n[Check-in manual: ' || p_motivo || ']'
                   ELSE E'\n[Check-in manual]'
              END
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;
  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;

  v_inicio_semana := date_trunc('week', v_now);

  SELECT count(*) INTO v_check_ins_hoy
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= date_trunc('day', v_now);

  SELECT count(*) INTO v_check_ins_semana
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= v_inicio_semana;

  IF v_rol IN ('recepcionista', 'admin') THEN
    PERFORM _audrec_log(
      'checkin.manual', 'reserva', p_reserva_id, v_reserva.usuario_id, v_miembro.nombre,
      format('Check-in manual de %s.%s',
             to_char(v_reserva.slot_inicio, 'DD/MM HH24:MI'),
             CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
                  THEN ' Motivo: ' || p_motivo ELSE '' END),
      jsonb_build_object('method', 'manual', 'motivo', p_motivo)
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva', row_to_json(v_reserva),
    'miembro', jsonb_build_object(
      'id', v_miembro.id,
      'nombre', v_miembro.nombre,
      'email', v_miembro.email,
      'telefono', v_miembro.telefono,
      'avatar_url', v_miembro.avatar_url,
      'membresia_tier', v_miembro.membresia_tier,
      'notas_admin', v_miembro.notas_admin
    ),
    'recurso', jsonb_build_object(
      'id', v_recurso.id,
      'nombre', v_recurso.nombre
    ),
    -- Lo que recepción tiene que ver: si está 'vencida'/'congelada'/'sin_membresia'
    -- la pantalla lo pinta en rojo. Acá SÍ puede venir distinto de 'ok'.
    'membresia_estado', _estado_membresia_checkin(v_reserva.usuario_id),
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION check_in_atomic(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION check_in_manual_atomic(uuid, text) TO authenticated;


-- ── 3) Check-in por huella — automático, así que BLOQUEA ────────────────────
-- Recreamos la función de 20260716120000 agregando UNA línea (el guard). Todo lo
-- demás es idéntico; la huella no tiene humano detrás, igual que el QR.
CREATE OR REPLACE FUNCTION check_in_por_huella(
  p_token text,
  p_usuario_id uuid,
  p_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lector lectores_biometricos;
  v_socio usuarios;
  v_reserva reservas;
  v_recurso recursos;
  v_clase clases;
  v_ventana integer;
BEGIN
  SELECT * INTO v_lector
  FROM lectores_biometricos
  WHERE token_hash = _hash_token_lector(p_token);

  IF v_lector.id IS NULL THEN
    RAISE EXCEPTION 'LECTOR_DESCONOCIDO: Ese lector no está dado de alta';
  END IF;

  IF NOT v_lector.activo THEN
    RAISE EXCEPTION 'LECTOR_INACTIVO: Ese lector está desactivado';
  END IF;

  -- Señal de vida: la usa el admin para saber si el aparato sigue conectado.
  UPDATE lectores_biometricos SET ultimo_visto_at = now() WHERE id = v_lector.id;

  -- El agente dice "es el socio X". Le creemos solo si X tiene una huella VIVA en
  -- ESTE gym: si no, un agente comprometido podría hacer entrar a cualquiera.
  SELECT u.* INTO v_socio
  FROM usuarios u
  WHERE u.id = p_usuario_id
    AND u.tenant_id = v_lector.tenant_id
    AND EXISTS (
      SELECT 1 FROM credenciales_biometricas c
      WHERE c.usuario_id = u.id
        AND c.tenant_id = v_lector.tenant_id
        AND c.revocada_at IS NULL
    );

  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'HUELLA_NO_RECONOCIDA: Esa huella no está registrada en este gimnasio';
  END IF;

  v_ventana := ventana_check_in_min(v_lector.tenant_id);

  -- ¿Qué reserva está entrando? La suya, confirmada, dentro de la ventana del gym,
  -- y en la sede donde está parado el lector. Si hay varias (clases pegadas), la
  -- más cercana al momento en que apoyó el dedo.
  SELECT r.* INTO v_reserva
  FROM reservas r
  JOIN recursos rec ON rec.id = r.recurso_id
  WHERE r.tenant_id = v_lector.tenant_id
    AND r.usuario_id = v_socio.id
    AND r.status = 'confirmada'
    AND p_at >= r.slot_inicio - (v_ventana || ' minutes')::interval
    AND p_at <= r.slot_fin + (v_ventana * 2 || ' minutes')::interval
    AND (
      v_lector.sucursal_id IS NULL
      OR rec.sucursal_id = v_lector.sucursal_id
    )
  ORDER BY abs(extract(epoch FROM (r.slot_inicio - p_at)))
  LIMIT 1;

  IF v_reserva.id IS NULL THEN
    -- No es un error del socio: es que no tiene clase ahora. Recepción decide qué
    -- hacer (crearle la reserva en el mostrador, por ejemplo).
    RAISE EXCEPTION 'SIN_RESERVA: % no tiene ninguna reserva para este momento',
      COALESCE(v_socio.nombre, v_socio.email);
  END IF;

  -- LA PUERTA NUEVA: la huella es automática. Membresía muerta no entra sola.
  PERFORM _guard_membresia_checkin(v_socio.id);

  UPDATE reservas
  SET status = 'completada',
      check_in_at = p_at,
      check_in_by = NULL,          -- no hay persona detrás: lo hizo el aparato
      check_in_method = 'huella'
  WHERE id = v_reserva.id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;
  SELECT * INTO v_clase   FROM clases   WHERE id = v_reserva.clase_id;

  PERFORM _audrec_log(
    'checkin.huella', 'reserva', v_reserva.id, v_socio.id, v_socio.nombre,
    format('Entró con huella por el lector "%s".', v_lector.nombre),
    jsonb_build_object('lector_id', v_lector.id, 'lector', v_lector.nombre)
  );

  RETURN jsonb_build_object(
    'success', true,
    'socio', jsonb_build_object(
      'id', v_socio.id,
      'nombre', v_socio.nombre,
      'avatar_url', v_socio.avatar_url
    ),
    'reserva_id', v_reserva.id,
    'clase', COALESCE(v_clase.nombre, v_recurso.nombre),
    'hora', to_char(v_reserva.slot_inicio, 'HH24:MI')
  );
END;
$$;

REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION check_in_por_huella(text, uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION check_in_por_huella(text, uuid, timestamptz) TO service_role;


-- ============================================================================
-- TEST DE CONTRATO: los guards tienen que seguir LLAMADOS donde corresponde.
--   · QR y huella → _guard_membresia_checkin (la puerta nueva).
--   · QR y manual → _guard_sucursal_staff (el guard viejo, que recreamos).
-- Si una recreación futura pierde alguno, la migración falla acá.
-- ============================================================================

-- ¿La función p_fn contiene una llamada a p_needle en su cuerpo?
CREATE OR REPLACE FUNCTION _fn_llama(p_fn text, p_needle text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = p_fn
      AND p.prosrc LIKE '%' || p_needle || '%'
  );
$$;

DO $$
DECLARE
  v_falta text[] := ARRAY[]::text[];
BEGIN
  -- membresía: QR + huella
  IF NOT _fn_llama('check_in_atomic', '_guard_membresia_checkin') THEN
    v_falta := array_append(v_falta, 'check_in_atomic→membresia');
  END IF;
  IF NOT _fn_llama('check_in_por_huella', '_guard_membresia_checkin') THEN
    v_falta := array_append(v_falta, 'check_in_por_huella→membresia');
  END IF;
  -- sucursal: QR + manual (no perder lo que ya había)
  IF NOT _fn_llama('check_in_atomic', '_guard_sucursal_staff') THEN
    v_falta := array_append(v_falta, 'check_in_atomic→sucursal');
  END IF;
  IF NOT _fn_llama('check_in_manual_atomic', '_guard_sucursal_staff') THEN
    v_falta := array_append(v_falta, 'check_in_manual_atomic→sucursal');
  END IF;
  -- la manual NO debe bloquear membresía (política: recepción decide)
  IF _fn_llama('check_in_manual_atomic', '_guard_membresia_checkin') THEN
    v_falta := array_append(v_falta, 'check_in_manual NO debería bloquear membresía');
  END IF;

  IF cardinality(v_falta) > 0 THEN
    RAISE EXCEPTION 'CONTRATO_ROTO: %', array_to_string(v_falta, ', ');
  END IF;
END;
$$;


-- ============================================================================
-- SELF-TEST funcional: vencida bloquea QR, manual pasa con aviso, viva entra.
-- ============================================================================
DO $$
DECLARE
  v_tenant uuid;
  v_admin uuid;
  v_auth uuid := gen_random_uuid();
  v_socio uuid;
  v_sucursal uuid;
  v_sala uuid;
  v_clase uuid;
  v_tier uuid;
  v_reserva uuid;
  v_res jsonb;
  v_err text;
  v_slug text := 'zz-test-checkin-' || substr(md5(random()::text), 1, 6);
  v_ahora timestamptz := now();
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test checkin', 'gym_libre', 'activo')
  RETURNING id INTO v_tenant;

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, raw_user_meta_data,
    encrypted_password, email_confirmed_at, created_at, updated_at
  ) VALUES (
    v_auth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    v_slug || '-admin@sala.dev',
    jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'),
    '', now(), now(), now()
  );
  UPDATE usuarios SET rol = 'admin', status = 'activo'
  WHERE auth_id = v_auth RETURNING id INTO v_admin;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug || '-socio@sala.dev', 'Socio Checkin', 'miembro', 'activo')
  RETURNING id INTO v_socio;

  INSERT INTO sucursales (tenant_id, nombre, timezone, activa, orden)
  VALUES (v_tenant, 'Sede test', 'America/Mexico_City', true, 0)
  RETURNING id INTO v_sucursal;

  INSERT INTO recursos (tenant_id, sucursal_id, slug, nombre, tipo, cupos, cupo_max_default, activo)
  VALUES (v_tenant, v_sucursal, 'sala-1', 'Sala 1', 'sala_grupal', 10, 10, true)
  RETURNING id INTO v_sala;

  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, activo, orden)
  VALUES (v_tenant, 'mensual', 'Mensual', 'tiempo', 100000, 'MXN', true, 0)
  RETURNING id INTO v_tier;

  INSERT INTO clases (tenant_id, sucursal_id, recurso_id, fecha, hora_inicio, duracion_minutos, cupo_max, status, nombre)
  VALUES (v_tenant, v_sucursal, v_sala, (v_ahora AT TIME ZONE 'UTC')::date,
          (v_ahora AT TIME ZONE 'UTC')::time, 60, 10, 'programada', 'Clase test')
  RETURNING id INTO v_clase;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_auth::text)::text, true);

  -- ── Caso A: membresía VENCIDA ──────────────────────────────────────────────
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
  VALUES (v_tenant, v_socio, v_tier, 'activa', v_ahora - interval '60 days', v_ahora - interval '1 day');

  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, clase_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio)
  VALUES (v_tenant, v_sala, v_socio, v_clase, v_ahora, v_ahora + interval '60 min', 60, 0, 'confirmada', 'SAL-CHK-A')
  RETURNING id INTO v_reserva;

  -- QR bloquea.
  BEGIN
    PERFORM check_in_atomic(v_reserva);
    RAISE EXCEPTION 'FALLA: QR dejó entrar con membresía vencida';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'MEMBRESIA_VENCIDA%' THEN RAISE; END IF;
  END;

  -- La reserva sigue confirmada (el bloqueo no la tocó).
  IF NOT EXISTS (SELECT 1 FROM reservas WHERE id = v_reserva AND status = 'confirmada') THEN
    RAISE EXCEPTION 'FALLA: el bloqueo de QR alteró la reserva';
  END IF;

  -- Manual pasa y avisa.
  v_res := check_in_manual_atomic(v_reserva, 'Va a renovar en caja');
  IF NOT (v_res->>'success')::boolean THEN
    RAISE EXCEPTION 'FALLA: la manual no dejó pasar (debería, con criterio)';
  END IF;
  IF v_res->>'membresia_estado' <> 'vencida' THEN
    RAISE EXCEPTION 'FALLA: la manual no avisó del estado vencido (devolvió %)', v_res->>'membresia_estado';
  END IF;

  -- ── Caso B: membresía CONGELADA + QR ───────────────────────────────────────
  UPDATE membresias SET status = 'congelada', periodo_actual_fin = v_ahora + interval '30 days'
  WHERE usuario_id = v_socio;

  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, clase_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio)
  VALUES (v_tenant, v_sala, v_socio, v_clase, v_ahora, v_ahora + interval '60 min', 60, 0, 'confirmada', 'SAL-CHK-B')
  RETURNING id INTO v_reserva;

  BEGIN
    PERFORM check_in_atomic(v_reserva);
    RAISE EXCEPTION 'FALLA: QR dejó entrar con membresía congelada';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'MEMBRESIA_CONGELADA%' THEN RAISE; END IF;
  END;

  -- ── Caso C: membresía VIVA + QR entra ──────────────────────────────────────
  UPDATE membresias SET status = 'activa', periodo_actual_fin = v_ahora + interval '30 days'
  WHERE usuario_id = v_socio;

  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, clase_id, slot_inicio, slot_fin, duracion_min, invitados_count, status, folio)
  VALUES (v_tenant, v_sala, v_socio, v_clase, v_ahora, v_ahora + interval '60 min', 60, 0, 'confirmada', 'SAL-CHK-C')
  RETURNING id INTO v_reserva;

  v_res := check_in_atomic(v_reserva);
  IF NOT (v_res->>'success')::boolean OR v_res->>'membresia_estado' <> 'ok' THEN
    RAISE EXCEPTION 'FALLA: QR no dejó entrar a una membresía viva';
  END IF;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
END;
$$;

SELECT 'QR bloquea membresía vencida' AS prueba, 'rechazado' AS espera, 'OK' AS resultado
UNION ALL SELECT 'QR bloquea membresía congelada', 'rechazado', 'OK'
UNION ALL SELECT 'el bloqueo de QR no toca la reserva', 'sigue confirmada', 'OK'
UNION ALL SELECT 'la manual deja pasar con criterio', 'entra', 'OK'
UNION ALL SELECT 'la manual avisa del estado (vencida)', 'membresia_estado=vencida', 'OK'
UNION ALL SELECT 'QR deja entrar a membresía viva', 'entra', 'OK';
