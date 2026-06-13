-- ============================================================================
-- SUCURSALES — A1 (clases de sede inactiva) + A2 (lockout de 0 sucursales)
-- ============================================================================
-- A1 · expandir_clases unía `sucursales s` SIN `AND s.activa`, así que el modelo
--      virtual expandía horarios de sedes DESACTIVADAS: un socio veía y podía
--      reservar clases de una sucursal apagada. Acá filtramos por s.activa en
--      ambas ramas (virtuales de regla + manuales/legacy).
--
-- A2 · El guard de "última sucursal activa" era solo client-side (Sucursales.tsx).
--      Un UPDATE directo o dos pestañas podían dejar el tenant con 0 sucursales
--      activas → SucursalProvider queda en null y todo el panel muestra vacío sin
--      forma de crear nada. Acá un trigger BEFORE UPDATE lo bloquea para TODOS
--      los actores.
-- ============================================================================

-- ── A1: expandir_clases v2.1 — excluye sucursales inactivas ─────────────────
DROP FUNCTION IF EXISTS expandir_clases(uuid, date, date);

CREATE FUNCTION expandir_clases(
  p_sucursal_id uuid,
  p_desde date,
  p_hasta date
)
RETURNS TABLE (
  clase_id uuid,
  horario_recurrente_id uuid,
  fecha date,
  hora_inicio time,
  duracion_minutos integer,
  recurso_id uuid,
  sucursal_id uuid,
  nombre text,
  disciplina text,
  descripcion text,
  cupo_max integer,
  instructor_id uuid,
  instructor_nombre text,
  status text,
  reservados integer,
  recurso_nombre text,
  recurso_foto_url text,
  recurso_tiers_permitidos text[],
  instructor_foto_url text,
  instructor_bio text,
  sucursal_timezone text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH params AS (
    SELECT
      get_my_tenant_id() AS tenant_id,
      p_desde AS desde,
      LEAST(p_hasta, (p_desde + interval '92 days')::date) AS hasta,
      (SELECT config->>'timezone' FROM tenants WHERE id = get_my_tenant_id()) AS tenant_tz
  ),
  virtuales AS (
    SELECT
      hr.id            AS horario_id,
      hr.sucursal_id   AS sucursal_id,
      hr.recurso_id    AS recurso_id,
      gs::date         AS fecha,
      hr.hora_inicio   AS hora_inicio,
      hr.duracion_minutos AS duracion_minutos,
      hr.nombre        AS nombre,
      (r.tipo_contenido)[1] AS disciplina,
      COALESCE(hr.cupo_max, r.cupo_max_default) AS cupo_max,
      hr.instructor_id AS instructor_id,
      r.nombre         AS recurso_nombre,
      r.foto_url       AS recurso_foto_url,
      r.tiers_permitidos AS recurso_tiers_permitidos,
      COALESCE(NULLIF(s.timezone, ''), pa.tenant_tz, 'America/Mexico_City') AS sucursal_timezone
    FROM params pa
    JOIN horarios_recurrentes hr
      ON hr.tenant_id = pa.tenant_id
     AND (p_sucursal_id IS NULL OR hr.sucursal_id = p_sucursal_id)
     AND hr.activo
    JOIN recursos r ON r.id = hr.recurso_id AND r.activo
    JOIN sucursales s ON s.id = hr.sucursal_id AND s.activa
    CROSS JOIN LATERAL generate_series(pa.desde::timestamp, pa.hasta::timestamp, '1 day'::interval) AS gs
    WHERE EXTRACT(DOW FROM gs)::int = ANY(hr.dias_semana)
  )
  -- 1) Instancias de regla: virtual + su materializada (override/reserva) si existe.
  SELECT
    c.id AS clase_id,
    v.horario_id AS horario_recurrente_id,
    v.fecha,
    v.hora_inicio,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.duracion_minutos ELSE v.duracion_minutos END,
    v.recurso_id,
    v.sucursal_id,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.nombre ELSE v.nombre END,
    v.disciplina,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.descripcion ELSE NULL END,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.cupo_max ELSE v.cupo_max END,
    CASE WHEN c.origen = 'recurrente_modificada' THEN c.instructor_id ELSE v.instructor_id END,
    i.nombre,
    COALESCE(c.status, 'programada'),
    COALESCE(res.reservados, 0),
    v.recurso_nombre,
    v.recurso_foto_url,
    v.recurso_tiers_permitidos,
    i.foto_url,
    i.bio,
    v.sucursal_timezone
  FROM virtuales v
  LEFT JOIN clases c
    ON c.horario_recurrente_id = v.horario_id AND c.fecha = v.fecha
  LEFT JOIN instructores i
    ON i.id = CASE WHEN c.origen = 'recurrente_modificada' THEN c.instructor_id ELSE v.instructor_id END
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS reservados
    FROM reservas
    WHERE clase_id = c.id AND status IN ('confirmada', 'completada')
  ) res ON c.id IS NOT NULL

  UNION ALL

  -- 2) Clases ad-hoc ('manual') y legacy sin regla.
  SELECT
    c.id,
    NULL::uuid,
    c.fecha,
    c.hora_inicio,
    c.duracion_minutos,
    c.recurso_id,
    c.sucursal_id,
    c.nombre,
    c.disciplina,
    c.descripcion,
    c.cupo_max,
    c.instructor_id,
    i.nombre,
    c.status,
    COALESCE((
      SELECT count(*)::int FROM reservas
      WHERE clase_id = c.id AND status IN ('confirmada', 'completada')
    ), 0),
    r.nombre,
    r.foto_url,
    r.tiers_permitidos,
    i.foto_url,
    i.bio,
    COALESCE(NULLIF(s.timezone, ''), pa.tenant_tz, 'America/Mexico_City')
  FROM params pa
  JOIN clases c
    ON c.tenant_id = pa.tenant_id
   AND (p_sucursal_id IS NULL OR c.sucursal_id = p_sucursal_id)
   AND c.horario_recurrente_id IS NULL
   AND c.fecha BETWEEN pa.desde AND pa.hasta
  JOIN recursos r ON r.id = c.recurso_id
  JOIN sucursales s ON s.id = c.sucursal_id AND s.activa
  LEFT JOIN instructores i ON i.id = c.instructor_id;
$$;

REVOKE ALL ON FUNCTION expandir_clases(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expandir_clases(uuid, date, date) TO authenticated;

COMMENT ON FUNCTION expandir_clases(uuid, date, date) IS
  'Modelo virtual v2.1: clases de un rango (sucursal NULL = todas las ACTIVAS del tenant) desde horarios_recurrentes + materializadas, con recurso/instructor/tz. Excluye sucursales inactivas (fix A1). clase_id NULL = virtual. Scopeada al tenant; rango máx 92 días.';

-- ── A2: trigger anti "0 sucursales activas" ─────────────────────────────────
CREATE OR REPLACE FUNCTION trg_proteger_sucursales()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Solo nos importa la transición activa → inactiva.
  IF OLD.activa AND NOT NEW.activa THEN
    -- En un BEFORE trigger la fila aún cuenta como activa → <=1 significa que
    -- esta es la única sucursal activa del tenant.
    IF (SELECT count(*) FROM sucursales
        WHERE tenant_id = OLD.tenant_id AND activa) <= 1 THEN
      RAISE EXCEPTION
        'ULTIMA_SUCURSAL: no podés desactivar la única sucursal activa del tenant.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_proteger_sucursales() IS
  'BEFORE UPDATE sucursales: impide desactivar la última sucursal activa de un tenant (evita lockout del panel).';

DROP TRIGGER IF EXISTS sucursales_proteger_ultima ON sucursales;
CREATE TRIGGER sucursales_proteger_ultima
  BEFORE UPDATE ON sucursales
  FOR EACH ROW
  EXECUTE FUNCTION trg_proteger_sucursales();

-- ============================================================================
-- TEST A2 — no se puede desactivar la última sucursal activa; sí una de varias.
-- ============================================================================
DO $$
DECLARE
  v_tenant uuid;
  v_slug text := 'zz-suc-test-'||substr(gen_random_uuid()::text, 1, 8);
  v_suc_a uuid; v_suc_b uuid;
  v_ok boolean;
BEGIN
  BEGIN  -- subtransacción reversible
    INSERT INTO tenants (slug, nombre, status) VALUES (v_slug, 'Suc Test', 'activo')
    RETURNING id INTO v_tenant;

    INSERT INTO sucursales (tenant_id, nombre, activa) VALUES (v_tenant, 'Sede A', true) RETURNING id INTO v_suc_a;
    INSERT INTO sucursales (tenant_id, nombre, activa) VALUES (v_tenant, 'Sede B', true) RETURNING id INTO v_suc_b;

    -- Con 2 activas, desactivar B debe PERMITIRSE.
    UPDATE sucursales SET activa = false WHERE id = v_suc_b;

    -- Ahora solo A activa: desactivarla debe BLOQUEARSE.
    v_ok := false;
    BEGIN
      UPDATE sucursales SET activa = false WHERE id = v_suc_a;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE 'ULTIMA_SUCURSAL%' THEN v_ok := true; ELSE RAISE; END IF;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'TEST A2 FALLO: se permitió desactivar la última sucursal activa.';
    END IF;

    RAISE EXCEPTION 'ROLLBACK_SENTINEL_A2';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_SENTINEL_A2' THEN
      RAISE NOTICE 'TEST A2 OK: última sucursal protegida; una de varias se puede desactivar. Revertido.';
    ELSE RAISE; END IF;
  END;
END $$;

-- ============================================================================
-- TEST A1 — expandir_clases NO devuelve clases de una sucursal inactiva.
-- ============================================================================
DO $$
DECLARE
  v_tenant uuid;
  v_slug text := 'zz-a1-test-'||substr(gen_random_uuid()::text, 1, 8);
  v_suc_a uuid; v_suc_b uuid;
  v_auth uuid := gen_random_uuid();
  v_recurso uuid;
  v_hoy date;
  v_antes int; v_despues int;
BEGIN
  BEGIN  -- subtransacción reversible
    INSERT INTO tenants (slug, nombre, status) VALUES (v_slug, 'A1 Test', 'activo')
    RETURNING id INTO v_tenant;

    INSERT INTO sucursales (tenant_id, nombre, activa) VALUES (v_tenant, 'Sede A', true) RETURNING id INTO v_suc_a;
    INSERT INTO sucursales (tenant_id, nombre, activa) VALUES (v_tenant, 'Sede B', true) RETURNING id INTO v_suc_b;

    -- Staff del tenant (para el JWT de expandir_clases).
    INSERT INTO auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES ('00000000-0000-0000-0000-000000000000', v_auth, 'authenticated', 'authenticated',
            'a1-'||substr(v_auth::text,1,8)||'@test.local',
            '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Staff A1'), now(), now());
    UPDATE usuarios SET rol='admin', status='activo' WHERE auth_id = v_auth;

    -- Recurso + horario (todos los días) en la SEDE B.
    INSERT INTO recursos (tenant_id, sucursal_id, slug, nombre)
    VALUES (v_tenant, v_suc_b, 'sala-b-'||substr(v_suc_b::text,1,8), 'Sala B')
    RETURNING id INTO v_recurso;

    INSERT INTO horarios_recurrentes (tenant_id, sucursal_id, recurso_id, dias_semana, hora_inicio, nombre)
    VALUES (v_tenant, v_suc_b, v_recurso, ARRAY[0,1,2,3,4,5,6], '09:00', 'Clase B');

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);
    SELECT (now() AT TIME ZONE 'UTC')::date INTO v_hoy;

    -- Con B activa: expandir trae las clases de B.
    SELECT count(*) INTO v_antes
    FROM expandir_clases(NULL, v_hoy, v_hoy + 7)
    WHERE sucursal_id = v_suc_b;
    IF v_antes = 0 THEN
      RAISE EXCEPTION 'TEST A1 SETUP FALLO: expandir no trajo clases de la sede B activa.';
    END IF;

    -- Desactivar B (A sigue activa → permitido por A2).
    UPDATE sucursales SET activa = false WHERE id = v_suc_b;

    -- Ahora B inactiva: expandir NO debe traer clases de B.
    SELECT count(*) INTO v_despues
    FROM expandir_clases(NULL, v_hoy, v_hoy + 7)
    WHERE sucursal_id = v_suc_b;
    IF v_despues <> 0 THEN
      RAISE EXCEPTION 'TEST A1 FALLO: expandir devolvió % clases de una sucursal INACTIVA.', v_despues;
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    RAISE EXCEPTION 'ROLLBACK_SENTINEL_A1';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_SENTINEL_A1' THEN
      RAISE NOTICE 'TEST A1 OK: sede activa traía % clases; tras desactivarla, expandir trae 0. Revertido.', v_antes;
    ELSE RAISE; END IF;
  END;
END $$;
