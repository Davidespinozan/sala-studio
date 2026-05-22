-- ============================================================================
-- Deuda técnica — prefijo de folio: "EKK-" → "SAL-"
-- ============================================================================
-- El prefijo "EKK-" es legacy del proyecto EKKO, del que SALA forkeó. Las dos
-- funciones que generan folios de reservas lo siguen usando:
--   - reservar_clase_atomic   (reserva normal)
--   - _promover_entrada       (promoción desde lista de espera)
--
-- Este cambio aplica SOLO a reservas NUEVAS. Las reservas ya existentes
-- conservan su folio "EKK-NNNNNN" — no se hace ningún UPDATE masivo (son datos
-- de prueba de sala-demo, no vale la pena).
--
-- POR QUÉ NO HAY RIESGO DE COLISIÓN al convivir folios EKK- y SAL-:
--   - El folio es prefijo + lpad(count(*) de reservas del tenant + 1).
--   - El número es count-based: crece monótonamente a medida que se agregan
--     reservas. EKK-000050 viejo → SAL-000051 nuevo → el número nunca retrocede.
--   - Aunque el número se repitiera, "EKK-NNNNNN" ≠ "SAL-NNNNNN" — el prefijo
--     los separa.
--   - reservas.folio NO tiene constraint UNIQUE (solo un índice no único
--     reservas_folio_idx), así que ni siquiera hay una restricción que violar.
--   → Mezclar ambos prefijos en sala-demo es totalmente seguro.
--
-- Solo CREATE OR REPLACE — firmas idénticas, los GRANT se preservan. Ambas
-- funciones son idénticas a su versión actual (multisede-3, 20260521100000);
-- el ÚNICO cambio es el literal del prefijo del folio.
-- ============================================================================

-- ============================================================================
-- A) reservar_clase_atomic — folio "SAL-"
-- ============================================================================

CREATE OR REPLACE FUNCTION reservar_clase_atomic(
  p_clase_id uuid,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL
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
  v_existe_doble boolean;
  v_existe_continua boolean;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;
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

  -- multisede-3: la tz es la de la SUCURSAL de la clase (fallback a la del tenant).
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

  IF v_usuario.status != 'activo' THEN
    RAISE EXCEPTION 'USUARIO_INACTIVO: Tu membresía no está activa (status: %)', v_usuario.status;
  END IF;

  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Tienes una restricción hasta el %',
      to_char(v_usuario.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  IF v_usuario.membresia_tier IS NULL OR
     NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
    RAISE EXCEPTION 'TIER_NO_PERMITIDO: Tu plan no tiene acceso a esta sala';
  END IF;

  v_max_invitados := max_invitados_por_tier(v_usuario.membresia_tier);
  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;
  IF p_invitados > v_max_invitados THEN
    RAISE EXCEPTION 'INVITADOS_EXCEDEN: Tu plan permite máximo % invitados', v_max_invitados;
  END IF;

  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  v_slot_fin    := v_slot_inicio + (v_clase.duracion_minutos || ' minutes')::interval;

  v_min_anticipacion_h := COALESCE((v_tenant.config->>'min_anticipacion_horas')::integer, 24);
  IF v_slot_inicio < v_now + (v_min_anticipacion_h || ' hours')::interval THEN
    RAISE EXCEPTION 'ANTICIPACION_INSUFICIENTE: Debes reservar con al menos % horas de anticipación', v_min_anticipacion_h;
  END IF;

  -- Doble reserva del mismo usuario en la misma clase
  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE clase_id = p_clase_id
      AND usuario_id = v_user_id
      AND status IN ('confirmada','completada')
  ) INTO v_existe_doble;
  IF v_existe_doble THEN
    RAISE EXCEPTION 'YA_RESERVADO: Ya tenés una reserva activa en esta clase';
  END IF;

  -- Horas continuas (mismo usuario, slot adyacente en cualquier clase)
  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE usuario_id = v_user_id
      AND status IN ('confirmada','completada')
      AND (slot_fin = v_slot_inicio OR slot_inicio = v_slot_fin)
  ) INTO v_existe_continua;
  IF v_existe_continua THEN
    RAISE EXCEPTION 'CONTINUA: No puedes reservar horas continuas';
  END IF;

  -- Cupo
  SELECT count(*) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id
    AND status IN ('confirmada','completada');

  IF v_cupos_ocupados >= v_clase.cupo_max THEN
    RAISE EXCEPTION 'CUPO_LLENO: Esta clase está llena (% / %)', v_cupos_ocupados, v_clase.cupo_max;
  END IF;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'SAL-' || lpad((v_folio_count + 1)::text, 6, '0');

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, notas,
    clase_id
  ) VALUES (
    v_tenant_id, v_clase.recurso_id, v_user_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    p_invitados, 'confirmada', v_folio_nuevo, p_notas,
    p_clase_id
  )
  RETURNING id INTO v_reserva_id;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo,
    'clase_id', p_clase_id
  );
END;
$$;

COMMENT ON FUNCTION reservar_clase_atomic(uuid, integer, text) IS
  'Reserva una clase por clase_id. Convierte fecha+hora con la timezone de la SUCURSAL de la clase. Folio "SAL-NNNNNN". No valida acceso por sucursal (Nivel 2).';

-- ============================================================================
-- B) _promover_entrada — folio "SAL-"
-- ============================================================================

CREATE OR REPLACE FUNCTION _promover_entrada(p_le_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry lista_espera;
  v_clase clases;
  v_tz text;
  v_slot_inicio timestamptz;
  v_slot_fin timestamptz;
  v_folio_count integer;
  v_folio text;
  v_reserva_id uuid;
BEGIN
  SELECT * INTO v_entry FROM lista_espera WHERE id = p_le_id;
  SELECT * INTO v_clase FROM clases WHERE id = v_entry.clase_id;

  -- multisede-3: tz de la sucursal de la clase (fallback a la del tenant).
  v_tz := timezone_de_sucursal(v_clase.sucursal_id, v_clase.tenant_id);
  v_slot_inicio := (v_clase.fecha + v_clase.hora_inicio) AT TIME ZONE v_tz;
  v_slot_fin := v_slot_inicio + (v_clase.duracion_minutos || ' minutes')::interval;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_clase.tenant_id;
  v_folio := 'SAL-' || lpad((v_folio_count + 1)::text, 6, '0');

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, clase_id, notas
  ) VALUES (
    v_clase.tenant_id, v_clase.recurso_id, v_entry.usuario_id,
    v_slot_inicio, v_slot_fin, v_clase.duracion_minutos,
    0, 'confirmada', v_folio, v_clase.id,
    'Promovido desde lista de espera'
  )
  RETURNING id INTO v_reserva_id;

  UPDATE lista_espera
  SET status = 'promovido', promovido_at = now(), reserva_id = v_reserva_id
  WHERE id = p_le_id;

  -- Notificación in-app (el miembro la ve al abrir la app).
  INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
  VALUES (
    v_clase.tenant_id, v_entry.usuario_id, 'lista_espera_promovido',
    '¡Se liberó un lugar!',
    'Se liberó un lugar en ' || v_clase.nombre || ' y tu reserva quedó confirmada.',
    jsonb_build_object('clase_id', v_clase.id, 'reserva_id', v_reserva_id)
  );

  RETURN v_reserva_id;
END;
$$;

COMMENT ON FUNCTION _promover_entrada(uuid) IS
  'Helper interno (lista de espera): crea la reserva confirmada de una entrada, la marca promovido y notifica. Folio "SAL-NNNNNN". No invocable por clientes.';

DO $$
BEGIN
  RAISE NOTICE 'Folio prefix EKK- → SAL- OK: reservar_clase_atomic y _promover_entrada actualizadas. Reservas existentes intactas.';
END $$;
