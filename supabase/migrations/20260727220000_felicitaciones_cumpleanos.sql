-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- FELICITACIÓN DE CUMPLEAÑOS por PUSH — usa la fecha de nacimiento de la ficha.
-- ────────────────────────────────────────────────────────────────────────────
-- Aprovecha el canal de push que ya existe: se inserta una fila en
-- `notificaciones` (tipo 'cumpleanos') y el cron-push la reparte sola — sin tocar
-- cron-push (que arma el push con el titulo/mensaje de la fila) ni CHECKs (el
-- `tipo` es texto libre).
--
-- generar_felicitaciones_cumpleanos() busca los socios activos que cumplen HOY
-- (mes/día, en la zona horaria de su gym) y crea la felicitación, una sola vez
-- por día (idempotente). La llama el cron diario cron-felicitaciones (service_role).
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION generar_felicitaciones_cumpleanos()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  r record;
  v_hoy date;
  v_nombre1 text;
BEGIN
  FOR r IN
    SELECT dp.usuario_id, dp.tenant_id, dp.fecha_nacimiento, u.nombre,
           COALESCE(t.config->>'timezone', 'America/Mexico_City') AS tz
    FROM usuarios_datos_privados dp
    JOIN usuarios u ON u.id = dp.usuario_id
    JOIN tenants  t ON t.id = dp.tenant_id
    WHERE dp.fecha_nacimiento IS NOT NULL
      AND u.rol = 'miembro'
      AND u.status = 'activo'
  LOOP
    v_hoy := (now() AT TIME ZONE r.tz)::date;

    -- ¿Cumple hoy? (mismo mes y día, en la tz del gym).
    IF EXTRACT(MONTH FROM r.fecha_nacimiento) = EXTRACT(MONTH FROM v_hoy)
       AND EXTRACT(DAY FROM r.fecha_nacimiento) = EXTRACT(DAY FROM v_hoy) THEN

      -- Idempotencia: no repetir si ya hubo una felicitación hoy.
      IF NOT EXISTS (
        SELECT 1 FROM notificaciones n
        WHERE n.usuario_id = r.usuario_id
          AND n.tipo = 'cumpleanos'
          AND (n.creada_at AT TIME ZONE r.tz)::date = v_hoy
      ) THEN
        v_nombre1 := NULLIF(split_part(COALESCE(r.nombre, ''), ' ', 1), '');
        INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje)
        VALUES (
          r.tenant_id, r.usuario_id, 'cumpleanos',
          '¡Feliz cumpleaños! 🎂',
          CASE WHEN v_nombre1 IS NOT NULL
            THEN '¡Feliz cumpleaños, ' || v_nombre1 || '! Que tengas un gran día. 🎉'
            ELSE '¡Feliz cumpleaños! Que tengas un gran día. 🎉' END
        );
        v_count := v_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN v_count;
END; $$;

-- Solo el servidor (cron).
REVOKE ALL ON FUNCTION generar_felicitaciones_cumpleanos() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION generar_felicitaciones_cumpleanos() TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — un socio que cumple HOY debe recibir la felicitación (una sola). Se
-- auto-verifica y revierte.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tenant uuid; v_socio uuid; v_tz text; v_hoy date; v_nac date; v_n int; v_dup int;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE status='activo' ORDER BY created_at LIMIT 1;
  IF v_tenant IS NULL THEN RAISE NOTICE 'TEST SKIP: sin tenant.'; RETURN; END IF;
  v_tz := COALESCE((SELECT config->>'timezone' FROM tenants WHERE id=v_tenant), 'America/Mexico_City');
  v_hoy := (now() AT TIME ZONE v_tz)::date;
  -- Año bisiesto por si hoy es 29-feb.
  v_nac := make_date(2000, EXTRACT(MONTH FROM v_hoy)::int, EXTRACT(DAY FROM v_hoy)::int);

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, 'cumple-test@example.com', 'Cumple Test', 'miembro', 'activo')
  RETURNING id INTO v_socio;
  INSERT INTO usuarios_datos_privados (usuario_id, tenant_id, fecha_nacimiento)
  VALUES (v_socio, v_tenant, v_nac);

  PERFORM generar_felicitaciones_cumpleanos();
  SELECT count(*) INTO v_n FROM notificaciones WHERE usuario_id=v_socio AND tipo='cumpleanos';
  IF v_n <> 1 THEN RAISE EXCEPTION 'TEST FALLO: se esperaba 1 felicitación, hubo %.', v_n; END IF;

  -- Idempotencia: correr otra vez no duplica.
  PERFORM generar_felicitaciones_cumpleanos();
  SELECT count(*) INTO v_dup FROM notificaciones WHERE usuario_id=v_socio AND tipo='cumpleanos';
  IF v_dup <> 1 THEN RAISE EXCEPTION 'TEST FALLO: se duplicó la felicitación (%).', v_dup; END IF;

  RAISE EXCEPTION 'ROLLBACK_OK_CUMPLE';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'TEST FALLO%' THEN RAISE;
  ELSIF SQLERRM = 'ROLLBACK_OK_CUMPLE' THEN NULL;
  ELSE RAISE;
  END IF;
END $$;

SELECT 'generar_felicitaciones_cumpleanos crea 1 felicitación por cumpleaños (idempotente)' AS prueba, true AS ok;
