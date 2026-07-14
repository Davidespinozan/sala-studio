-- ============================================================================
-- Los defaults castigaban al gym que no tocaba nada
-- ----------------------------------------------------------------------------
-- Tres valores que ningún dueño eligió y que igual mandaban. Los tres los
-- descubrimos porque un cliente REAL se los comió (a Numa le apagué el bloqueo
-- de no-show a mano). El gym #2 se los volvía a comer igual.
--
-- Un default no es una opinión neutra: es la decisión que toma el sistema por
-- vos cuando no dijiste nada. Y estos tres decidían en contra del socio.
--
--   1) ANTICIPACIÓN MÍNIMA = 24 HORAS.
--      Un gym que no toca la config no deja reservar la clase de mañana a las
--      7am si ya son las 9am de hoy (22h < 24h). El socio ve
--      "ANTICIPACION_INSUFICIENTE" y el dueño no entiende por qué. La mayoría
--      quiere 0. → Default 0. El que quiera un umbral lo sube en Reglas.
--
--   2) BLOQUEO POR INASISTENCIA = 7 DÍAS.
--      Si el gym no hace check-in con disciplina, el cron marca no-show a gente
--      que SÍ fue, le quema el crédito y encima la deja una semana afuera. Un
--      castigo de una semana no puede ser lo que pasa cuando nadie decidió nada.
--      → Default 0: registrar la falta, no castigar. Castigar se elige.
--
--   3) PERMANENCIA = 6 MESES.
--      `activar_suscripcion_socio` escribía commitment_ends_at = hoy + 6 meses,
--      ignorando `config.membresia.commitment_meses` (que el onboarding pone en
--      0 y que NADIE leía). Nadie la enforza —no hay un solo RAISE en toda la
--      base— pero el admin SÍ la ve en la ficha del socio. O sea: a cada gym se
--      le mostraba una permanencia de medio año que jamás pactó. → Sale de la
--      config; 0 = sin permanencia (NULL).
--
-- Los tres cuerpos se copiaron literal de su definición vigente y se parcheó
-- solo la línea del default; el diff se verificó línea por línea. Al final, el
-- test de contrato de siempre: ninguna de las funciones recreadas puede haber
-- perdido un guard en la copia.
-- ============================================================================

-- ── 1) Anticipación mínima: 24h → 0 ─────────────────────────────────────────
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
  v_mem_inicio timestamptz;
  v_mem_fin timestamptz;
  v_mem_creditos integer;
  v_tier_tipo text;
  v_nuevo_creditos integer;
  v_costo integer;
  v_tier_todas_sedes boolean;
  v_mem_sucursal uuid;

  -- Invitados por periodo (reemplaza el techo por clase)
  v_inv_incluidos integer;
  v_inv_usados integer;
  v_inv_disponibles integer;
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
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

  -- MAPA DE SALÓN: si la sala tiene layout, el socio reserva un LUGAR puntual.
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
    SELECT m.id, m.status, m.periodo_actual_inicio, m.periodo_actual_fin,
           m.creditos_restantes, t.tipo,
           t.acceso_todas_sucursales, m.sucursal_id,
           COALESCE(t.invitados_por_periodo, 0)
    INTO v_mem_id, v_mem_status, v_mem_inicio, v_mem_fin,
         v_mem_creditos, v_tier_tipo,
         v_tier_todas_sedes, v_mem_sucursal,
         v_inv_incluidos
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

  -- Alcance por sede: si el plan no da acceso a todas las sedes, la clase debe
  -- ser de la sede a la que el socio se suscribió.
  IF v_es_socio AND NOT COALESCE(v_tier_todas_sedes, true)
     AND v_mem_sucursal IS NOT NULL AND v_clase.sucursal_id IS NOT NULL
     AND v_mem_sucursal <> v_clase.sucursal_id THEN
    RAISE EXCEPTION 'SUCURSAL_NO_INCLUIDA: Tu plan solo cubre tu sede';
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- INVITADOS: bolsa POR PERIODO (antes era un techo por clase).
  -- La bolsa la define el plan (tiers.invitados_por_periodo) y se gasta al
  -- reservar. Cancelar una reserva devuelve sus pases (deja de contar acá).
  -- ───────────────────────────────────────────────────────────────────────
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

  -- Default 0: sin anticipación mínima. Antes eran 24 HORAS, y un gym que no
  -- tocaba la config no dejaba reservar la clase de mañana a las 7am si ya eran
  -- las 9am de hoy. Nadie eligió eso. El que quiera un umbral, lo sube en Reglas.
  v_min_anticipacion_h := COALESCE(
    (v_tenant.config->'reserva'->>'anticipacion_min_horas')::integer,
    (v_tenant.config->>'min_anticipacion_horas')::integer,
    0);
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
    'creditos_restantes', v_nuevo_creditos,
    'invitados_restantes', CASE
      WHEN v_es_socio AND COALESCE(v_inv_incluidos, 0) > 0
        THEN GREATEST(COALESCE(v_inv_disponibles, v_inv_incluidos) - p_invitados, 0)
      ELSE 0
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION reservar_clase_atomic(uuid, integer, text, text) TO authenticated;


-- ── 2) Bloqueo por inasistencia: 7 días → 0 ─────────────────────────────────
CREATE OR REPLACE FUNCTION marcar_no_shows()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reservas_afectadas integer := 0;
  v_usuarios_bloqueados integer := 0;
  v_now timestamptz := now();
  v_bloqueo_dias integer;
  v_bloqueado_hasta timestamptz;
  r record;
BEGIN
  FOR r IN
    SELECT
      res.id,
      res.usuario_id,
      res.tenant_id,
      res.folio,
      t.config AS tenant_config
    FROM reservas res
    JOIN tenants t ON t.id = res.tenant_id
    WHERE res.status = 'confirmada'
      AND res.check_in_at IS NULL
      AND res.slot_fin + interval '30 minutes' < v_now
  LOOP
    v_bloqueo_dias := COALESCE(
      (r.tenant_config->'penalizaciones'->>'no_show_bloqueo_dias')::integer,
      (r.tenant_config->>'no_show_bloqueo_dias')::integer,
      0  -- default: registrar la falta, NO castigar. Castigar se elige.
    );

    UPDATE reservas SET status = 'no_show' WHERE id = r.id;
    v_reservas_afectadas := v_reservas_afectadas + 1;

    PERFORM _registrar_no_show_ledger(r.id, NULL);

    IF v_bloqueo_dias > 0 THEN
      UPDATE usuarios
      SET bloqueado_hasta = GREATEST(
            COALESCE(bloqueado_hasta, v_now),
            v_now + (v_bloqueo_dias || ' days')::interval
          )
      WHERE id = r.usuario_id
      RETURNING bloqueado_hasta INTO v_bloqueado_hasta;
      v_usuarios_bloqueados := v_usuarios_bloqueados + 1;

      INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
      VALUES (
        r.tenant_id, r.usuario_id, 'no_show',
        'No asististe a tu clase',
        'Se registró una inasistencia (' || COALESCE(r.folio, 'reserva')
          || '). No vas a poder reservar hasta el ' || to_char(v_bloqueado_hasta, 'DD/MM') || '.',
        jsonb_build_object('reserva_id', r.id, 'bloqueado_hasta', v_bloqueado_hasta)
      );
    ELSE
      -- El gym eligió NO penalizar. La falta se registra, pero sin bloqueo ni
      -- amenaza: el aviso solo informa.
      INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
      VALUES (
        r.tenant_id, r.usuario_id, 'no_show',
        'No asististe a tu clase',
        'Se registró una inasistencia (' || COALESCE(r.folio, 'reserva')
          || '). Si no vas a poder ir, cancelá con tiempo para liberar el lugar.',
        jsonb_build_object('reserva_id', r.id)
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'reservas_afectadas', v_reservas_afectadas,
    'usuarios_bloqueados', v_usuarios_bloqueados,
    'timestamp', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION marcar_no_shows() FROM PUBLIC;
REVOKE ALL ON FUNCTION marcar_no_shows() FROM anon;
REVOKE ALL ON FUNCTION marcar_no_shows() FROM authenticated;
GRANT EXECUTE ON FUNCTION marcar_no_shows() TO service_role;


-- ── 3) Permanencia: 6 meses fijos → lo que diga el gym ──────────────────────
CREATE OR REPLACE FUNCTION activar_suscripcion_socio(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_stripe_subscription_id text DEFAULT NULL,
  p_stripe_customer_id text DEFAULT NULL,
  p_periodo_fin timestamptz DEFAULT NULL,
  -- Cobro real (lo informa el webhook de Stripe). NULL/0 → no registra dinero.
  p_monto_centavos integer DEFAULT NULL,
  p_referencia text DEFAULT NULL,
  p_inscripcion_centavos integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_commitment_meses integer;
  v_commitment_ends timestamptz;
  v_socio usuarios;
  v_tier tiers;
  v_now timestamptz := now();
  v_fin timestamptz;
  v_mem_id uuid;
  v_old_creditos integer;
  v_nuevo_creditos integer;
  v_es_paquete boolean;
  v_dias integer;
BEGIN
  SELECT * INTO v_socio FROM usuarios WHERE id = p_usuario_id;
  IF v_socio.id IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE';
  END IF;
  IF v_socio.rol <> 'miembro' THEN
    RAISE EXCEPTION 'ROL_INVALIDO: solo socios pueden tener membresía';
  END IF;

  SELECT * INTO v_tier FROM tiers WHERE id = p_tier_id;
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'TIER_NO_EXISTE';
  END IF;
  IF v_tier.tenant_id <> v_socio.tenant_id THEN
    RAISE EXCEPTION 'TIER_DE_OTRO_TENANT';
  END IF;
  IF v_tier.activo IS NOT TRUE THEN
    RAISE EXCEPTION 'TIER_INACTIVO';
  END IF;

  v_es_paquete := v_tier.tipo IN ('creditos', 'hibrido') AND p_stripe_subscription_id IS NULL;

  -- Días de vigencia del plan. duracion_dias es la fuente de verdad (quincenal
  -- = 15); el periodo solo es el fallback histórico si la columna está vacía.
  v_dias := COALESCE(
    v_tier.duracion_dias,
    CASE v_tier.periodo
      WHEN 'anual'     THEN 365
      WHEN 'quincenal' THEN 15
      ELSE 30
    END
  );

  v_fin := CASE
    WHEN v_tier.tipo = 'hibrido'  THEN v_now + (v_dias || ' days')::interval
    WHEN v_tier.tipo = 'creditos' THEN NULL
    -- tipo='tiempo': manda el periodo que informa Stripe; si no vino (alta
    -- manual o pago único), se usa la vigencia REAL del plan.
    ELSE COALESCE(p_periodo_fin, v_now + (v_dias || ' days')::interval)
  END;

  SELECT id, creditos_restantes INTO v_mem_id, v_old_creditos
  FROM membresias
  WHERE usuario_id = p_usuario_id
    AND status IN ('activa', 'trialing', 'past_due', 'congelada')
  ORDER BY created_at DESC
  LIMIT 1;

  v_nuevo_creditos := CASE
    WHEN v_tier.tipo = 'tiempo' THEN NULL
    WHEN v_es_paquete           THEN COALESCE(v_old_creditos, 0) + COALESCE(v_tier.clases_incluidas, 0)
    ELSE COALESCE(v_tier.clases_incluidas, 0)
  END;

  -- PERMANENCIA: la decide el GYM, no el código. Antes se escribían 6 MESES
  -- fijos, ignorando `config.membresia.commitment_meses` (que el onboarding pone
  -- en 0 y nadie leía). Nada la enforzaba —no hay un solo RAISE— pero el admin SÍ
  -- la veía en la ficha del socio: el sistema le mostraba a cada gym una
  -- permanencia de medio año que jamás eligió. 0 o NULL = sin permanencia.
  SELECT COALESCE((config->'membresia'->>'commitment_meses')::integer, 0)
  INTO v_commitment_meses
  FROM tenants
  WHERE id = v_socio.tenant_id;

  v_commitment_ends := CASE
    WHEN COALESCE(v_commitment_meses, 0) > 0
      THEN v_now + (v_commitment_meses || ' months')::interval
    ELSE NULL
  END;

  IF v_mem_id IS NULL THEN
    INSERT INTO membresias (
      tenant_id, usuario_id, tier_id, status,
      periodo_actual_inicio, periodo_actual_fin, commitment_ends_at,
      creditos_restantes, stripe_subscription_id, stripe_customer_id
    ) VALUES (
      v_socio.tenant_id, p_usuario_id, p_tier_id, 'activa',
      v_now, v_fin, v_commitment_ends,
      v_nuevo_creditos, p_stripe_subscription_id, p_stripe_customer_id
    )
    RETURNING id INTO v_mem_id;
  ELSE
    UPDATE membresias SET
      tier_id = p_tier_id,
      status = 'activa',
      periodo_actual_inicio = v_now,
      periodo_actual_fin = v_fin,
      creditos_restantes = v_nuevo_creditos,
      stripe_subscription_id = COALESCE(p_stripe_subscription_id, stripe_subscription_id),
      stripe_customer_id = COALESCE(p_stripe_customer_id, stripe_customer_id),
      cancelada_at = NULL,
      cancelada_efectiva_at = NULL,
      updated_at = v_now
    WHERE id = v_mem_id;
  END IF;

  -- Ledger de créditos.
  IF v_tier.tipo IN ('creditos', 'hibrido') THEN
    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos, reserva_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_socio.tenant_id,
      CASE WHEN COALESCE(v_nuevo_creditos, 0) - COALESCE(v_old_creditos, 0) >= 0 THEN 'alta' ELSE 'ajuste' END,
      COALESCE(v_nuevo_creditos, 0) - COALESCE(v_old_creditos, 0),
      NULL,
      CASE WHEN v_es_paquete THEN 'compra de paquete ' || v_tier.slug ELSE 'activación de plan ' || v_tier.slug END,
      p_usuario_id
    );
  END IF;

  -- ── DINERO (nuevo): registrar lo que Stripe cobró de verdad ───────────────
  IF COALESCE(p_monto_centavos, 0) > 0 THEN
    INSERT INTO pagos (
      tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
      concepto, monto_centavos, moneda, metodo, referencia, cobrado_por
    ) VALUES (
      v_socio.tenant_id, NULL, p_usuario_id, v_mem_id, p_tier_id,
      CASE WHEN v_es_paquete THEN 'paquete' ELSE 'plan' END,
      p_monto_centavos, COALESCE(v_tier.moneda, 'MXN'), 'stripe', p_referencia, NULL
    )
    ON CONFLICT DO NOTHING;  -- el webhook puede reintentar
  END IF;

  IF COALESCE(p_inscripcion_centavos, 0) > 0 THEN
    INSERT INTO pagos (
      tenant_id, sucursal_id, usuario_id, membresia_id, tier_id,
      concepto, monto_centavos, moneda, metodo, referencia, cobrado_por
    ) VALUES (
      v_socio.tenant_id, NULL, p_usuario_id, v_mem_id, p_tier_id,
      'inscripcion', p_inscripcion_centavos, COALESCE(v_tier.moneda, 'MXN'),
      'stripe', p_referencia, NULL
    )
    ON CONFLICT DO NOTHING;

    UPDATE usuarios
    SET inscripcion_pagada_at = COALESCE(inscripcion_pagada_at, v_now)
    WHERE id = p_usuario_id;
  END IF;

  UPDATE usuarios SET
    membresia_activa_id = v_mem_id,
    membresia_tier = v_tier.slug,
    status = 'activo',
    stripe_customer_id = COALESCE(p_stripe_customer_id, stripe_customer_id),
    updated_at = v_now
  WHERE id = p_usuario_id;

  RETURN jsonb_build_object(
    'ok', true,
    'membresia_id', v_mem_id,
    'tier_slug', v_tier.slug,
    'periodo_fin', v_fin
  );
END;
$$;

REVOKE ALL ON FUNCTION activar_suscripcion_socio(uuid, uuid, text, text, timestamptz, integer, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION activar_suscripcion_socio(uuid, uuid, text, text, timestamptz, integer, text, integer) FROM anon;
REVOKE ALL ON FUNCTION activar_suscripcion_socio(uuid, uuid, text, text, timestamptz, integer, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION activar_suscripcion_socio(uuid, uuid, text, text, timestamptz, integer, text, integer) TO service_role;


-- ============================================================================
-- TEST DE CONTRATO: la copia no puede haber perdido guards.
-- ============================================================================
DO $$
DECLARE
  v_src text;
  v_codigo text;
  v_faltan text[] := ARRAY[]::text[];

  c_reservar text[] := ARRAY[
    'NO_AUTH', 'CLASE_NO_EXISTE', 'CLASE_NO_PROGRAMADA', 'RECURSO_NO_EXISTE',
    'RECURSO_INACTIVO', 'LUGAR_SIN_INVITADOS', 'LUGAR_REQUERIDO', 'LUGAR_INVALIDO',
    'LUGAR_OCUPADO', 'USUARIO_INACTIVO', 'USUARIO_BLOQUEADO', 'SIN_MEMBRESIA',
    'MEMBRESIA_CONGELADA', 'MEMBRESIA_VENCIDA', 'SIN_CREDITOS', 'TIER_NO_PERMITIDO',
    'SUCURSAL_NO_INCLUIDA', 'INVITADOS_INVALIDOS', 'CUPO_LLENO', 'YA_RESERVADO',
    'ANTICIPACION_INSUFICIENTE', '_sala_permite_tier'
  ];
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'reservar_clase_atomic';
  FOREACH v_codigo IN ARRAY c_reservar LOOP
    IF position(v_codigo IN v_src) = 0 THEN
      v_faltan := array_append(v_faltan, 'reservar_clase_atomic:' || v_codigo);
    END IF;
  END LOOP;

  -- El bloqueo tiene que seguir EXISTIENDO (configurable), no desaparecer.
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'marcar_no_shows';
  IF position('bloqueado_hasta' IN v_src) = 0 THEN
    v_faltan := array_append(v_faltan, 'marcar_no_shows:bloqueado_hasta');
  END IF;
  IF position('_registrar_no_show_ledger' IN v_src) = 0 THEN
    v_faltan := array_append(v_faltan, 'marcar_no_shows:_registrar_no_show_ledger');
  END IF;

  -- La activación tiene que seguir registrando el dinero.
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'activar_suscripcion_socio';
  IF position('pagos' IN v_src) = 0 THEN
    v_faltan := array_append(v_faltan, 'activar_suscripcion_socio:pagos');
  END IF;
  IF position('v_commitment_ends' IN v_src) = 0 THEN
    v_faltan := array_append(v_faltan, 'activar_suscripcion_socio:v_commitment_ends');
  END IF;

  IF cardinality(v_faltan) > 0 THEN
    RAISE EXCEPTION 'GUARD_PERDIDO en la recreación: %', array_to_string(v_faltan, ', ');
  END IF;
END;
$$;


-- ============================================================================
-- SELF-TEST: los defaults nuevos son los que mandan.
-- ============================================================================
SELECT
  'anticipación mínima: default 0, ya no 24h' AS prueba,
  'default nuevo presente' AS espera,
  CASE WHEN prosrc LIKE '%sin anticipación mínima%' THEN 'OK' ELSE 'FALLA' END AS resultado
FROM pg_proc WHERE proname = 'reservar_clase_atomic'

UNION ALL

SELECT
  'bloqueo por inasistencia: default 0 (registrar, no castigar)',
  'default nuevo presente',
  CASE WHEN prosrc LIKE '%NO castigar%' THEN 'OK' ELSE 'FALLA' END
FROM pg_proc WHERE proname = 'marcar_no_shows'

UNION ALL

SELECT
  'permanencia: sale de la config, no de un 6 fijo',
  'sin interval 6 months',
  CASE WHEN prosrc LIKE '%6 months%' THEN 'FALLA: sigue el 6' ELSE 'OK' END
FROM pg_proc WHERE proname = 'activar_suscripcion_socio'

UNION ALL

-- Lo que cada GYM tiene hoy configurado de verdad (lo que ya eligió gana).
SELECT
  'config real de ' || t.slug,
  'anticipación / bloqueo / permanencia',
  COALESCE(t.config->'reserva'->>'anticipacion_min_horas', '(default 0)') || 'h  ·  ' ||
  COALESCE(t.config->'penalizaciones'->>'no_show_bloqueo_dias', '(default 0)') || 'd  ·  ' ||
  COALESCE(t.config->'membresia'->>'commitment_meses', '(default 0)') || ' meses'
FROM tenants t
ORDER BY 1;
