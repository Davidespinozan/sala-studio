-- ============================================================================
-- CONFIGURACIÓN QUE MENTÍA: perillas que se guardaban y nadie leía
-- ----------------------------------------------------------------------------
-- Dos ajustes del gym existían en la UI y en config, pero NINGÚN código los
-- leía. El dueño creía haber configurado algo y no configuraba nada:
--
--   · "Ventana de check-in (min)": el check-in usaba ventanas FIJAS en el código
--     (QR: 15 min antes / 30 después; manual: 30 antes / 60 después).
--   · "Anticipación máxima (días)": no se validaba en ningún lado. Un socio podía
--     reservar más allá del límite; solo lo frenaba la interfaz.
--
-- Ahora las dos mandan de verdad. Los defaults son los valores que ya estaban
-- hardcodeados, así que ningún gym cambia de comportamiento sin tocar nada.
-- ============================================================================

-- ── Helper: la ventana de check-in del tenant (en minutos, antes de la clase) ─
CREATE OR REPLACE FUNCTION ventana_check_in_min(p_tenant_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (config->'reserva'->>'ventana_check_in_min')::integer,
    (config->>'ventana_check_in_min')::integer,
    15  -- el valor que estaba fijo en el código
  )
  FROM tenants WHERE id = p_tenant_id;
$$;

-- ── 1) Check-in por QR: la ventana sale de la config ────────────────────────
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

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este miembro ya hizo check-in (% UTC)', v_reserva.check_in_at;
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'RESERVA_CANCELADA: Esta reserva fue cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'RESERVA_NO_SHOW: Esta reserva fue marcada como inasistencia';
  END IF;

  -- La ventana la decide el GYM (Ajustes → Reglas), no el código.
  v_ventana_min := ventana_check_in_min(v_tenant_id);
  v_ventana_inicio := v_reserva.slot_inicio - (v_ventana_min || ' minutes')::interval;
  -- El cierre acompaña: la clase + el doble de la ventana (default 30, como antes).
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
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;

-- ── 2) Check-in manual: misma config, ventana más generosa ──────────────────
-- El manual siempre fue más laxo que el QR (el socio ya está ahí, enfrente).
-- Se conserva la proporción: el doble de la ventana configurada.
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

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'YA_CHECK_IN: Este miembro ya hizo check-in';
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'RESERVA_CANCELADA: Reserva cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'RESERVA_NO_SHOW: Reserva marcada como inasistencia';
  END IF;

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
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;

-- ── 3) Day Pass de Numa: vence en 1 día, no en 30 ───────────────────────────
-- Un "pase de día" que dura un mes no es un pase de día.
UPDATE tiers
SET duracion_dias = 1
WHERE slug = 'daypass'
  AND duracion_dias = 30
  AND tenant_id = (SELECT id FROM tenants WHERE slug = 'numawellness');


-- ── 4) Anticipación MÁXIMA: ahora se valida de verdad ───────────────────────
-- Estaba en la config y en la UI, pero ningún código la miraba: un socio podía
-- reservar más allá del límite (solo lo frenaba la interfaz, que se puede
-- saltear). Va como guard en la BASE, que es donde una regla de negocio no se
-- puede evitar.
--
-- Solo aplica al SOCIO reservando para sí mismo. El staff (walk-in, reserva de
-- mostrador) puede reservar cuando quiera: si el recepcionista lo decide, es
-- porque hay un motivo.
CREATE OR REPLACE FUNCTION trg_anticipacion_maxima()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_dias integer;
BEGIN
  IF get_my_rol() <> 'miembro' THEN
    RETURN NEW;  -- staff: sin tope
  END IF;

  SELECT COALESCE(
    (config->'reserva'->>'anticipacion_max_dias')::integer,
    (config->>'anticipacion_max_dias')::integer,
    30
  ) INTO v_max_dias
  FROM tenants WHERE id = NEW.tenant_id;

  IF v_max_dias > 0 AND NEW.slot_inicio > now() + (v_max_dias || ' days')::interval THEN
    RAISE EXCEPTION 'ANTICIPACION_EXCEDIDA: Solo podés reservar con % días de anticipación', v_max_dias;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS anticipacion_maxima ON reservas;
CREATE TRIGGER anticipacion_maxima
  BEFORE INSERT ON reservas
  FOR EACH ROW EXECUTE FUNCTION trg_anticipacion_maxima();

-- ============================================================================
-- SELF-TEST
-- ============================================================================
WITH checks AS (
  SELECT 'la ventana de check-in sale de la config del gym' AS prueba,
         (SELECT pg_get_functiondef(oid) LIKE '%ventana_check_in_min(v_tenant_id)%'
            FROM pg_proc WHERE proname = 'check_in_atomic' LIMIT 1) AS ok
  UNION ALL
  SELECT 'el check-in manual también',
         (SELECT pg_get_functiondef(oid) LIKE '%ventana_check_in_min(v_tenant_id)%'
            FROM pg_proc WHERE proname = 'check_in_manual_atomic' LIMIT 1)
  UNION ALL
  SELECT 'sin config, la ventana sigue siendo 15 min (nadie cambia sin querer)',
         ventana_check_in_min((SELECT id FROM tenants WHERE slug = 'numawellness')) = 15
  UNION ALL
  SELECT 'la anticipación máxima se valida en la base (no solo en la UI)',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'anticipacion_maxima')
  UNION ALL
  SELECT 'Day Pass de Numa vence en 1 día',
         EXISTS (SELECT 1 FROM tiers t JOIN tenants te ON te.id = t.tenant_id
                 WHERE te.slug = 'numawellness' AND t.slug = 'daypass' AND t.duracion_dias = 1)
)
SELECT CASE WHEN ok THEN '✅' ELSE '❌' END AS estado, prueba
FROM checks
ORDER BY ok, prueba;
