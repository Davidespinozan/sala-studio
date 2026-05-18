-- ============================================================================
-- Perfil extendido: notas operativas + bucket de avatares
-- ============================================================================

-- 1. Columna `notas_admin` en usuarios (solo admin escribe, recepción lee)
ALTER TABLE usuarios
ADD COLUMN IF NOT EXISTS notas_admin text;

COMMENT ON COLUMN usuarios.notas_admin IS
  'Notas operativas del miembro (condiciones físicas, preferencias, recordatorios).
   Solo admin las edita. Recepción las ve durante check-in.';

-- 2. Bucket de avatares en Storage (idempotente)
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

-- 3. Policies del bucket: público para leer, admin del tenant para escribir
DROP POLICY IF EXISTS "avatars_public_read" ON storage.objects;
CREATE POLICY "avatars_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "avatars_admin_write" ON storage.objects;
CREATE POLICY "avatars_admin_write"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'avatars'
    AND auth.role() = 'authenticated'
    AND get_my_rol() IN ('admin', 'staff')
  );

DROP POLICY IF EXISTS "avatars_admin_update" ON storage.objects;
CREATE POLICY "avatars_admin_update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'avatars'
    AND get_my_rol() IN ('admin', 'staff')
  );

DROP POLICY IF EXISTS "avatars_admin_delete" ON storage.objects;
CREATE POLICY "avatars_admin_delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'avatars'
    AND get_my_rol() IN ('admin', 'staff')
  );

-- ============================================================================
-- Actualizar check_in_atomic para devolver contador + notas + avatar
-- ============================================================================

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
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;

  IF v_rol NOT IN ('admin', 'recepcionista', 'staff') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo staff puede hacer check-in';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'EKKO_TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'EKKO_YA_CHECK_IN: Este miembro ya hizo check-in (% UTC)', v_reserva.check_in_at;
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_CANCELADA: Esta reserva fue cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_SHOW: Esta reserva fue marcada como inasistencia';
  END IF;

  v_ventana_inicio := v_reserva.slot_inicio - interval '15 minutes';
  v_ventana_fin := v_reserva.slot_fin + interval '30 minutes';

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'EKKO_DEMASIADO_TEMPRANO: El check-in abre 15 min antes (a las %)',
      to_char(v_ventana_inicio, 'HH24:MI');
  END IF;

  IF v_now > v_ventana_fin THEN
    RAISE EXCEPTION 'EKKO_DEMASIADO_TARDE: El check-in cerró a las %',
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

  -- Contadores
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

-- ============================================================================
-- Actualizar check_in_manual_atomic para devolver lo mismo
-- ============================================================================

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
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;

  IF v_rol NOT IN ('admin', 'recepcionista', 'staff') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo staff puede hacer check-in';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'EKKO_TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'EKKO_YA_CHECK_IN: Este miembro ya hizo check-in';
  END IF;

  IF v_reserva.status = 'cancelada' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_CANCELADA: Reserva cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_SHOW: Reserva marcada como inasistencia';
  END IF;

  v_ventana_inicio := v_reserva.slot_inicio - interval '30 minutes';
  v_ventana_fin := v_reserva.slot_fin + interval '60 minutes';

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'EKKO_DEMASIADO_TEMPRANO: El check-in manual abre 30 min antes (a las %)',
      to_char(v_ventana_inicio, 'HH24:MI');
  END IF;

  IF v_now > v_ventana_fin THEN
    RAISE EXCEPTION 'EKKO_DEMASIADO_TARDE: El check-in manual cerró a las %',
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
