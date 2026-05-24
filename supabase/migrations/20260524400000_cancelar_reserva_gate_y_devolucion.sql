-- ============================================================================
-- Membresías Prepago — Fase 2B: ventana de cancelación + devolución de crédito
-- ============================================================================
-- Reescribe cancelar_reserva_atomic con la contraparte del gate de Fase 2A.2:
-- si la cancelación es A TIEMPO (dentro de la ventana definida por el tenant),
-- se devuelve 1 crédito al DUEÑO de la reserva (no al que cancela). Si es
-- TARDE, la reserva se cancela igual pero no se devuelve crédito.
--
-- ALCANCE — solo cuando el DUEÑO de la reserva es socio (rol miembro) Y su
-- membresía es tipo creditos o hibrido Y hubo un movimiento 'debito' previo
-- para esa reserva Y todavía no se devolvió. Tipo tiempo no tiene crédito que
-- devolver. Staff cancelando: no aplica devolución a quien cancela; si el
-- dueño es socio, la devolución va a su membresía aunque cancele el admin.
--
-- VENTANA — leída de tenants.config->'reserva'->>'cancelacion_min_horas' con
-- default 4 horas (cubre tenants existentes sin la clave). El onboarding de
-- tenants nuevos pasa a sembrar la clave explícitamente. "A tiempo" =
-- now() < slot_inicio - ventana. NO bloquea cancelar — solo decide devolución.
--
-- RESERVA_PASADA — sigue bloqueando (la clase ya empezó: no se cancela ni se
-- devuelve nada). Eso no cambia.
--
-- CONCURRENCIA — FOR UPDATE sobre la membresía del dueño antes de inspeccionar
-- débito/devolución previa, y todo el bloque (UPDATE reserva + UPDATE
-- membresía + INSERT movimiento) corre en la misma transacción del SECURITY
-- DEFINER. Imposible doble-devolución por race: la 2da llamada concurrente
-- bloquea esperando el lock; cuando lee, encuentra el movimiento 'devolucion'
-- ya escrito y no devuelve de nuevo.
--
-- DOBLE CANCELACIÓN — la guarda `status = 'confirmada'` impide cancelar dos
-- veces (la 2da llamada da RESERVA_NO_CANCELABLE). Adicionalmente, el chequeo
-- "ya existe 'devolucion' para esta reserva" en membresia_movimientos previene
-- doble devolución si por algún motivo se llamara desde otro flujo.
--
-- CONTRATO DE RESPUESTA — antes devolvía la fila `reservas` (RETURNS reservas);
-- ahora devuelve `jsonb` por consistencia con reservar_clase_atomic y para
-- comunicar el resultado de la devolución al caller. Los consumidores
-- existentes (src/member/hooks/useReservas.ts) solo leen `error`, así que el
-- cambio no rompe call sites — pero el helper TS se actualiza para parsear
-- el shape nuevo.
--
-- CAMBIO PARALELO — crear_tenant_onboarding pasa a sembrar
-- 'cancelacion_min_horas': 4 en config.reserva para tenants nuevos. Los
-- existentes quedan cubiertos por el COALESCE en el RPC.
--
-- NOTA DE TRADE-OFF (no se resuelve acá) — al cancelar a tiempo + devolver,
-- el trigger `reservas_promover_lista_espera` dispara y `_promover_entrada`
-- crea una reserva confirmada para el primero en la cola SIN debitar crédito.
-- Eso es asimétrico (el gym "regala" un crédito en el flujo de promoción).
-- Pendiente: definir si la lista de espera también debe debitar. Por ahora se
-- preserva el comportamiento actual.
-- ============================================================================

-- ============================================================================
-- A) cancelar_reserva_atomic — ventana + devolución
-- ============================================================================
-- DROP previo: la función actual devuelve `reservas` (versión 20260514100900);
-- la nueva devuelve `jsonb`. CREATE OR REPLACE FUNCTION no permite cambiar el
-- tipo de retorno → hay que dropear primero. No hay dependencias hard (ningún
-- trigger ni función la llama), así que el DROP es seguro. El GRANT que la
-- versión original le había dado a `authenticated` se vuelve a otorgar
-- explícitamente después del CREATE (los GRANTs se pierden con el DROP).
DROP FUNCTION IF EXISTS cancelar_reserva_atomic(uuid, text);

CREATE OR REPLACE FUNCTION cancelar_reserva_atomic(
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
  v_user_rol text;
  v_reserva reservas;
  v_tenant tenants;
  v_now timestamptz := now();

  -- Ventana
  v_ventana_h integer;
  v_es_a_tiempo boolean;

  -- Dueño de la reserva (puede ser distinto del que cancela)
  v_owner_id uuid;
  v_owner_rol text;

  -- Membresía + ledger del dueño
  v_mem_id uuid;
  v_mem_status text;
  v_tier_tipo text;
  v_debit_count integer;
  v_refund_count integer;

  -- Resultado de la devolución
  v_devolver boolean := false;
  v_devolucion_motivo text := 'no_aplica';
  v_nuevo_creditos integer;
BEGIN
  v_user_id := get_my_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT rol INTO v_user_rol FROM usuarios WHERE id = v_user_id;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;
  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  -- Autorización: dueño de la reserva o staff (admin/recepción) del tenant.
  -- Antes la guarda era is_admin(); is_recepcionista() es admin+recepción, más
  -- alineado con la convención del codebase (admin cancela = recepción cancela).
  IF v_reserva.usuario_id <> v_user_id AND NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: No puedes cancelar esta reserva';
  END IF;

  IF v_reserva.status <> 'confirmada' THEN
    RAISE EXCEPTION 'RESERVA_NO_CANCELABLE: La reserva no está confirmada (status: %)', v_reserva.status;
  END IF;

  -- La clase ya empezó: nada se hace (ni cancelar, ni devolver).
  IF v_reserva.slot_inicio <= v_now THEN
    RAISE EXCEPTION 'RESERVA_PASADA: No podés cancelar una reserva cuya clase ya empezó';
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- Ventana de cancelación
  -- ───────────────────────────────────────────────────────────────────────
  -- Default 4h (cubre tenants existentes sin la clave). El onboarding nuevo
  -- siembra la clave explícitamente.
  SELECT * INTO v_tenant FROM tenants WHERE id = v_reserva.tenant_id;
  v_ventana_h := COALESCE(
    (v_tenant.config->'reserva'->>'cancelacion_min_horas')::integer,
    4
  );
  v_es_a_tiempo := v_now < (v_reserva.slot_inicio - (v_ventana_h || ' hours')::interval);

  -- ───────────────────────────────────────────────────────────────────────
  -- Devolución de crédito (al DUEÑO, no a quien cancela)
  -- ───────────────────────────────────────────────────────────────────────
  -- Se evalúa si corresponde, pero el UPDATE de la reserva se hace SIEMPRE
  -- (la ventana solo decide la devolución, no bloquea la cancelación).
  v_owner_id := v_reserva.usuario_id;
  SELECT rol INTO v_owner_rol FROM usuarios WHERE id = v_owner_id;

  IF v_owner_rol = 'miembro' THEN
    SELECT m.id, m.status, t.tipo
    INTO v_mem_id, v_mem_status, v_tier_tipo
    FROM membresias m
    JOIN tiers t ON t.id = m.tier_id
    WHERE m.usuario_id = v_owner_id
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

    IF v_mem_id IS NOT NULL AND v_tier_tipo IN ('creditos', 'hibrido') THEN
      -- ¿Hubo débito previo asociado a esta reserva?
      SELECT count(*) INTO v_debit_count
      FROM membresia_movimientos
      WHERE membresia_id = v_mem_id
        AND reserva_id = p_reserva_id
        AND tipo = 'debito';

      -- ¿Ya se devolvió? Anti doble-devolución.
      SELECT count(*) INTO v_refund_count
      FROM membresia_movimientos
      WHERE membresia_id = v_mem_id
        AND reserva_id = p_reserva_id
        AND tipo = 'devolucion';

      IF v_debit_count > 0 AND v_refund_count = 0 THEN
        IF v_es_a_tiempo THEN
          v_devolver := true;
          v_devolucion_motivo := 'a_tiempo';
        ELSE
          v_devolucion_motivo := 'tarde';
        END IF;
      ELSE
        -- Tier es creditos/hibrido pero la reserva nunca debitó (ej. reserva
        -- creada por staff sin pasar por el gate). No hay nada que devolver.
        v_devolucion_motivo := 'sin_credito';
      END IF;
    ELSE
      -- Sin membresía vigente, o tier=tiempo (sin créditos que devolver).
      v_devolucion_motivo := 'sin_credito';
    END IF;
  END IF;
  -- Si v_owner_rol no es 'miembro' (staff reservó para sí), no aplica devolución.

  -- ───────────────────────────────────────────────────────────────────────
  -- Cancelar la reserva (siempre — la ventana solo decide la devolución)
  -- ───────────────────────────────────────────────────────────────────────
  UPDATE reservas
  SET status = 'cancelada',
      cancelada_at = v_now,
      cancelada_motivo = p_motivo,
      cancelada_por = v_user_id
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  -- ───────────────────────────────────────────────────────────────────────
  -- Devolución atómica si aplica
  -- ───────────────────────────────────────────────────────────────────────
  IF v_devolver THEN
    UPDATE membresias
    SET creditos_restantes = COALESCE(creditos_restantes, 0) + 1
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_reserva.tenant_id, 'devolucion', 1,
      p_reserva_id,
      'cancelación a tiempo de reserva ' || COALESCE(v_reserva.folio, '(sin folio)'),
      v_user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', p_reserva_id,
    'status', v_reserva.status,
    'devuelto', v_devolver,
    'devolucion_motivo', v_devolucion_motivo,
    'ventana_horas', v_ventana_h,
    'creditos_restantes', v_nuevo_creditos
  );
END;
$$;

COMMENT ON FUNCTION cancelar_reserva_atomic(uuid, text) IS
  'Cancela una reserva confirmada. Autoriza al dueño y a staff (admin/recepción) del tenant. RESERVA_PASADA bloquea si la clase ya empezó. La cancelación procede siempre dentro de tiempo permitido; la ventana (config.reserva.cancelacion_min_horas, default 4h) solo decide si se devuelve 1 crédito al DUEÑO. Aplica solo cuando el dueño es miembro con tier creditos/hibrido y hubo débito previo en el ledger. Atómica con UPDATE membresías + INSERT movimiento devolución; FOR UPDATE serializa contra doble devolución. Devuelve jsonb { success, reserva_id, status, devuelto, devolucion_motivo, ventana_horas, creditos_restantes }.';

-- Re-otorgar el GRANT que tenía la versión original (20260514100900:211).
-- Sin esto, después del DROP la function queda sin EXECUTE para authenticated
-- y los clientes del front no pueden llamarla.
GRANT EXECUTE ON FUNCTION cancelar_reserva_atomic(uuid, text) TO authenticated;

-- ============================================================================
-- B) crear_tenant_onboarding — sembrar cancelacion_min_horas: 4 en config
-- ============================================================================
-- CREATE OR REPLACE idéntica a la versión vigente (20260522200000) excepto por
-- la adición de 'cancelacion_min_horas': 4 dentro de jsonb_build_object('reserva',...).
-- Los demás campos del onboarding (tenant, sucursal, admin, suscripción, tiers,
-- primera sala) no se tocan.

CREATE OR REPLACE FUNCTION crear_tenant_onboarding(
  p_auth_id uuid,
  p_admin_nombre text,
  p_admin_email text,
  p_gym_nombre text,
  p_slug text,
  p_timezone text,
  p_tier_saas text,
  p_moneda text,
  p_precio_centavos integer,
  p_color_primario text,
  p_logo_url text,
  p_sala_nombre text,
  p_sala_cupo integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_sucursal_id uuid;
  v_sala_slug text;
  v_fin_trial timestamptz := now() + interval '7 days';
BEGIN
  -- ── 1. Tenant ──
  INSERT INTO tenants (slug, nombre, vertical, branding, config, status)
  VALUES (
    p_slug,
    p_gym_nombre,
    'gym_libre',
    jsonb_build_object(
      'logo_url', p_logo_url,
      'color_primary', p_color_primario,
      'color_bg', '#F5F1E8',
      'color_accent', '#D4A93C'
    ),
    jsonb_build_object(
      'timezone', p_timezone,
      'reserva', jsonb_build_object(
        'duracion_default_min', 60,
        'anticipacion_min_horas', 24,
        'anticipacion_max_dias', 30,
        'permitir_continuas', false,
        'ventana_check_in_min', 15,
        'cancelacion_min_horas', 4    -- ← NUEVO: ventana para devolución de crédito
      ),
      'membresia', jsonb_build_object(
        'commitment_meses', 0,
        'permite_invitados', true,
        'max_invitados_default', 2
      )
    ),
    'activo'
  )
  RETURNING id INTO v_tenant_id;

  -- ── 1b. Sucursal default del gym nuevo ──
  INSERT INTO sucursales (tenant_id, nombre, timezone, activa, orden)
  VALUES (v_tenant_id, 'Sucursal Principal', p_timezone, true, 0)
  RETURNING id INTO v_sucursal_id;

  -- ── 2. Usuario admin (vinculado al auth user ya creado) ──
  INSERT INTO usuarios (auth_id, tenant_id, email, nombre, rol, status)
  VALUES (p_auth_id, v_tenant_id, lower(p_admin_email), p_admin_nombre, 'admin', 'activo');

  -- ── 3. Suscripción al SaaS (trial 7 días, pago mock) ──
  INSERT INTO suscripciones_saas (
    tenant_id, tier, moneda, estado,
    trial_termina, periodo_actual_termina, precio_centavos,
    stripe_customer_id, stripe_subscription_id
  )
  VALUES (
    v_tenant_id, p_tier_saas, p_moneda, 'trial',
    v_fin_trial, v_fin_trial, p_precio_centavos,
    'mock_cus_' || substr(md5(random()::text), 1, 10),
    'mock_sub_' || substr(md5(random()::text), 1, 10)
  );

  -- ── 4. Tiers base del gym (basica + pro). ──
  INSERT INTO tiers (tenant_id, slug, nombre, descripcion, precio_centavos, moneda, periodo, activo, orden)
  VALUES
    (v_tenant_id, 'basica', 'Básica',
     'Plan de entrada. Editá el precio y los beneficios desde Planes.',
     0, upper(p_moneda), 'mensual', true, 1),
    (v_tenant_id, 'pro', 'Pro',
     'Plan completo. Editá el precio y los beneficios desde Planes.',
     0, upper(p_moneda), 'mensual', true, 2);

  -- ── 5. Primera sala (en la sucursal default) ──
  v_sala_slug := COALESCE(
    NULLIF(trim(both '-' from lower(regexp_replace(p_sala_nombre, '[^a-z0-9]+', '-', 'gi'))), ''),
    'sala-1'
  );
  INSERT INTO recursos (
    tenant_id, sucursal_id, slug, nombre, tipo, cupos, cupo_max_default,
    tiers_permitidos, activo, orden
  )
  VALUES (
    v_tenant_id, v_sucursal_id, v_sala_slug, p_sala_nombre, 'sala_grupal',
    p_sala_cupo, p_sala_cupo,
    ARRAY['basica', 'pro'], true, 1
  );

  RETURN jsonb_build_object('success', true, 'tenant_id', v_tenant_id, 'slug', p_slug);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'SLUG_TOMADO: El subdominio "%" ya está en uso', p_slug;
END;
$$;

-- Permisos preservados (idénticos a la versión anterior).

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Fase 2B OK: cancelar_reserva_atomic ahora aplica ventana + devolución de crédito. crear_tenant_onboarding siembra cancelacion_min_horas=4 en config. Probá con scripts/test_membresias_cancelacion.sql.';
END $$;
