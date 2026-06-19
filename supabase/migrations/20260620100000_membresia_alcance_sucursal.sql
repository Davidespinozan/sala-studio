-- ============================================================================
-- Alcance de membresía por sucursal (Fase 6 multi-sucursal)
-- ----------------------------------------------------------------------------
-- El admin decide, por plan, si la membresía da acceso a TODAS las sedes o solo
-- a la sede a la que el socio se suscribió:
--   · tiers.acceso_todas_sucursales (default true = comportamiento actual).
--   · membresias.sucursal_id          (la sede suscrita; backfill = la del socio).
-- reservar_clase_atomic ahora rechaza reservar en otra sede si el plan no es de
-- acceso total. Es el MISMO RPC de 20260617120000, recreado idéntico + el guard
-- de sede tras la validación de tier.
-- ============================================================================

ALTER TABLE tiers
  ADD COLUMN IF NOT EXISTS acceso_todas_sucursales boolean NOT NULL DEFAULT true;

ALTER TABLE membresias
  ADD COLUMN IF NOT EXISTS sucursal_id uuid REFERENCES sucursales(id) ON DELETE SET NULL;

-- Backfill: la membresía queda atada a la sede "home" del socio.
UPDATE membresias m
SET sucursal_id = u.sucursal_id
FROM usuarios u
WHERE u.id = m.usuario_id
  AND m.sucursal_id IS NULL
  AND u.sucursal_id IS NOT NULL;

-- Demo (healthyspace): 'basica' = solo su sede; 'pro' sigue con acceso total.
-- current_user = postgres → los guardrails no bloquean esto.
UPDATE tiers
SET acceso_todas_sucursales = false
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'healthyspace')
  AND slug = 'basica';

-- ─────────────────────────────────────────────────────────────────────────────
-- reservar_clase_atomic + guard de sede (idéntico a 20260617120000 salvo lo
-- marcado con "Fase 6").
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reservar_clase_atomic(
  p_clase_id uuid,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL,
  p_lugar_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_min_anticipacion_h integer;
  v_max_invitados integer;
  v_cupos_ocupados integer;
  v_cupo_efectivo integer;
  v_existe_doble boolean;
  v_existe_continua boolean;
  v_permitir_continuas boolean;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;

  -- Rol y gate de membresía
  v_es_socio boolean;
  v_mem_id uuid;
  v_mem_status text;
  v_mem_fin timestamptz;
  v_mem_creditos integer;
  v_tier_tipo text;
  v_nuevo_creditos integer;
  v_costo integer;
  v_tier_todas_sedes boolean;  -- Fase 6
  v_mem_sucursal uuid;         -- Fase 6
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

  -- ───────────────────────────────────────────────────────────────────────
  -- MAPA DE SALÓN: si la sala tiene layout, el socio reserva un LUGAR puntual.
  -- ───────────────────────────────────────────────────────────────────────
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
      WHERE clase_id = p_clase_id AND lugar_id = p_lugar_id
        AND status IN ('confirmada','completada')
    ) THEN
      RAISE EXCEPTION 'LUGAR_OCUPADO: Ese lugar ya está tomado, elegí otro';
    END IF;
  ELSE
    p_lugar_id := NULL; -- sala sin mapa: se ignora cualquier lugar enviado.
  END IF;

  v_es_socio := v_usuario.rol = 'miembro';

  IF v_usuario.status != 'activo' THEN
    RAISE EXCEPTION 'USUARIO_INACTIVO: Tu membresía no está activa (status: %)', v_usuario.status;
  END IF;

  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Tienes una restricción hasta el %',
      to_char(v_usuario.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  IF v_es_socio THEN
    SELECT m.id, m.status, m.periodo_actual_fin, m.creditos_restantes, t.tipo,
           t.acceso_todas_sucursales, m.sucursal_id                          -- Fase 6
    INTO v_mem_id, v_mem_status, v_mem_fin, v_mem_creditos, v_tier_tipo,
         v_tier_todas_sedes, v_mem_sucursal                                   -- Fase 6
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
    IF v_usuario.membresia_tier IS NULL OR
       NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
      RAISE EXCEPTION 'TIER_NO_PERMITIDO: Tu plan no tiene acceso a esta sala';
    END IF;
  END IF;

  -- Fase 6 — alcance por sede: si el plan no da acceso a todas las sedes, la
  -- clase debe ser de la sede a la que el socio se suscribió.
  IF v_es_socio AND NOT COALESCE(v_tier_todas_sedes, true)
     AND v_mem_sucursal IS NOT NULL AND v_clase.sucursal_id IS NOT NULL
     AND v_mem_sucursal <> v_clase.sucursal_id THEN
    RAISE EXCEPTION 'SUCURSAL_NO_INCLUIDA: Tu plan solo cubre tu sede';
  END IF;

  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;
  IF v_es_socio THEN
    v_max_invitados := COALESCE(
      (SELECT (t.reglas->>'max_invitados')::int FROM tiers t
        WHERE t.tenant_id = v_tenant_id AND t.slug = v_usuario.membresia_tier),
      max_invitados_por_tier(v_usuario.membresia_tier)
    );
    IF p_invitados > v_max_invitados THEN
      RAISE EXCEPTION 'INVITADOS_EXCEDEN: Tu plan permite máximo % invitados', v_max_invitados;
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

  v_min_anticipacion_h := COALESCE(
    (v_tenant.config->'reserva'->>'anticipacion_min_horas')::integer,
    (v_tenant.config->>'min_anticipacion_horas')::integer,
    24);
  IF v_slot_inicio < v_now + (v_min_anticipacion_h || ' hours')::interval THEN
    RAISE EXCEPTION 'ANTICIPACION_INSUFICIENTE: Debes reservar con al menos % horas de anticipación', v_min_anticipacion_h;
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

  -- Cupo = PERSONAS. Con mapa, el cupo efectivo es la cantidad de lugares.
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
    clase_id, lugar_id
  ) VALUES (
    v_tenant_id, v_clase.recurso_id, v_user_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    p_invitados, 'confirmada', v_folio_nuevo, p_notas,
    p_clase_id, p_lugar_id
  )
  RETURNING id INTO v_reserva_id;

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
    'creditos_restantes', v_nuevo_creditos
  );
END;
$$;

GRANT EXECUTE ON FUNCTION reservar_clase_atomic(uuid, integer, text, text) TO authenticated;
REVOKE ALL ON FUNCTION reservar_clase_atomic(uuid, integer, text, text) FROM PUBLIC;
