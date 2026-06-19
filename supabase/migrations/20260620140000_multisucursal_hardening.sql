-- ============================================================================
-- Multi-sucursal — hardening de coherencia (cierre del plan)
-- ----------------------------------------------------------------------------
-- 1) Lista de espera respeta el alcance por sede (gemelo de reservar_clase_atomic).
--    Sin esto, un socio de una sede podía anotarse a la lista de OTRA sede,
--    gastar un crédito y ser auto-promovido a una reserva fuera de su plan.
--    Tapamos el INGRESO (anotar_lista_espera): si no te podés anotar, la
--    promoción nunca te alcanza. (Las funciones de promoción quedan sin guard
--    redundante a propósito: bajo valor una vez cerrado el ingreso.)
-- 2) Cambiar la sede "home" del socio re-vincula su membresía activa
--    (membresias.sucursal_id), para que un plan de una sede no quede apuntando
--    a la sede vieja tras una mudanza.
-- 3) Todo socio nuevo recibe una sede por defecto si no se le asignó una, así
--    NINGÚN camino de creación deja usuarios.sucursal_id en NULL (lo que lo
--    haría invisible a la recepción por sede y a su propio alcance de plan).
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) anotar_lista_espera + guard de sede (idéntico a 20260526100000 + Fase 6).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION anotar_lista_espera(p_clase_id uuid)
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
  v_tz text;
  v_now timestamptz := now();
  v_slot_inicio timestamptz;
  v_cupos_ocupados integer;
  v_le_id uuid;
  v_le_created timestamptz;
  v_posicion integer;

  -- Rol y gate de membresía (paralelo a reservar_clase_atomic)
  v_es_socio boolean;
  v_mem_id uuid;
  v_mem_status text;
  v_mem_fin timestamptz;
  v_mem_creditos integer;
  v_tier_tipo text;
  v_nuevo_creditos integer;
  v_tier_todas_sedes boolean;  -- Fase 6
  v_mem_sucursal uuid;         -- Fase 6
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();
  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = v_user_id;
  SELECT * INTO v_clase FROM clases WHERE id = p_clase_id;

  IF v_clase.id IS NULL OR v_clase.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'CLASE_NO_EXISTE: Esta clase no existe en tu gimnasio';
  END IF;
  IF v_clase.status <> 'programada' THEN
    RAISE EXCEPTION 'CLASE_NO_PROGRAMADA: Esta clase no está disponible';
  END IF;

  -- La clase no debe haber empezado ya — multisede-3: tz de la sucursal.
  v_tz := timezone_de_sucursal(v_clase.sucursal_id, v_clase.tenant_id);
  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  IF v_slot_inicio <= v_now THEN
    RAISE EXCEPTION 'CLASE_PASADA: Esta clase ya empezó';
  END IF;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;
  IF v_recurso.id IS NULL OR NOT v_recurso.activo THEN
    RAISE EXCEPTION 'RECURSO_INACTIVO: Esta sala no está disponible';
  END IF;

  v_es_socio := v_usuario.rol = 'miembro';

  IF v_usuario.status <> 'activo' THEN
    RAISE EXCEPTION 'USUARIO_INACTIVO: Tu membresía no está activa';
  END IF;
  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Tenés una restricción activa';
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- GATE de membresía (solo socios). FOR UPDATE serializa el débito.
  -- Paralelo a reservar_clase_atomic — los mismos errores, mismas reglas.
  -- ───────────────────────────────────────────────────────────────────────
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

    IF v_tier_tipo IN ('creditos', 'hibrido')
       AND COALESCE(v_mem_creditos, 0) <= 0 THEN
      RAISE EXCEPTION 'SIN_CREDITOS: Te quedaste sin créditos en tu paquete';
    END IF;
  END IF;

  -- Tier del recurso (solo socios) — fuera del gate para preservar el orden
  -- existente; los mensajes anteriores se conservan.
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

  -- No puede anotarse si ya tiene reserva activa en la clase.
  IF EXISTS (
    SELECT 1 FROM reservas
    WHERE clase_id = p_clase_id AND usuario_id = v_user_id
      AND status IN ('confirmada', 'completada')
  ) THEN
    RAISE EXCEPTION 'YA_RESERVADO: Ya tenés una reserva en esta clase';
  END IF;

  -- Ni si ya está esperando.
  IF EXISTS (
    SELECT 1 FROM lista_espera
    WHERE clase_id = p_clase_id AND usuario_id = v_user_id AND status = 'esperando'
  ) THEN
    RAISE EXCEPTION 'YA_EN_LISTA: Ya estás en la lista de espera de esta clase';
  END IF;

  -- La clase debe estar LLENA.
  SELECT count(*) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id AND status IN ('confirmada', 'completada');
  IF v_cupos_ocupados < v_clase.cupo_max THEN
    RAISE EXCEPTION 'HAY_CUPO: La clase tiene lugares disponibles, reservá normalmente';
  END IF;

  BEGIN
    INSERT INTO lista_espera (tenant_id, clase_id, usuario_id, status)
    VALUES (v_tenant_id, p_clase_id, v_user_id, 'esperando')
    RETURNING id, created_at INTO v_le_id, v_le_created;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'YA_EN_LISTA: Ya estás en la lista de espera de esta clase';
  END;

  SELECT count(*) INTO v_posicion
  FROM lista_espera
  WHERE clase_id = p_clase_id AND status = 'esperando'
    AND (created_at, id) <= (v_le_created, v_le_id);

  -- ───────────────────────────────────────────────────────────────────────
  -- DÉBITO (solo socios con tier creditos/hibrido). Atómico con el INSERT.
  -- Si algo arriba abortó, esto nunca corrió.
  -- ───────────────────────────────────────────────────────────────────────
  IF v_es_socio AND v_tier_tipo IN ('creditos', 'hibrido') THEN
    UPDATE membresias
    SET creditos_restantes = creditos_restantes - 1
    WHERE id = v_mem_id
    RETURNING creditos_restantes INTO v_nuevo_creditos;

    INSERT INTO membresia_movimientos (
      membresia_id, tenant_id, tipo, delta_creditos,
      reserva_id, lista_espera_id, motivo, created_by
    ) VALUES (
      v_mem_id, v_tenant_id, 'debito', -1,
      NULL, v_le_id, 'lista_espera ' || v_clase.nombre, v_user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'lista_espera_id', v_le_id,
    'posicion', v_posicion,
    'creditos_restantes', v_nuevo_creditos
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Re-vincular la membresía activa cuando cambia la sede "home" del socio.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION usuario_rebind_membresia_sucursal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sucursal_id IS DISTINCT FROM OLD.sucursal_id AND NEW.sucursal_id IS NOT NULL THEN
    UPDATE membresias
    SET sucursal_id = NEW.sucursal_id
    WHERE usuario_id = NEW.id
      AND status IN ('trialing', 'activa', 'past_due', 'congelada');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_usuario_rebind_membresia_sucursal ON usuarios;
CREATE TRIGGER trg_usuario_rebind_membresia_sucursal
  AFTER UPDATE OF sucursal_id ON usuarios
  FOR EACH ROW EXECUTE FUNCTION usuario_rebind_membresia_sucursal();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Sede por defecto para todo socio nuevo sin sede explícita.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION usuario_default_sucursal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sucursal_id IS NULL AND NEW.tenant_id IS NOT NULL THEN
    SELECT id INTO NEW.sucursal_id
    FROM sucursales
    WHERE tenant_id = NEW.tenant_id AND activa = true
    ORDER BY orden ASC, created_at ASC
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_usuario_default_sucursal ON usuarios;
CREATE TRIGGER trg_usuario_default_sucursal
  BEFORE INSERT ON usuarios
  FOR EACH ROW EXECUTE FUNCTION usuario_default_sucursal();

-- Backfill: socios existentes sin sede → sede por defecto de su tenant.
UPDATE usuarios u
SET sucursal_id = (
  SELECT s.id FROM sucursales s
  WHERE s.tenant_id = u.tenant_id AND s.activa = true
  ORDER BY s.orden ASC, s.created_at ASC
  LIMIT 1
)
WHERE u.sucursal_id IS NULL;
