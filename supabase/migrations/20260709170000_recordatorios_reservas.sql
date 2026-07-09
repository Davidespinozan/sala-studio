-- ============================================================================
-- Recordatorios de clase (~1h antes) — feature de retención que faltaba (ekko).
-- ----------------------------------------------------------------------------
-- generar_recordatorios_reservas(): para cada reserva 'confirmada' que empieza
-- en ~45-75 min y todavía sin recordatorio, inserta una notificación in-app
-- (SALA ya tiene la tabla notificaciones + realtime + campana) y la marca con
-- recordatorio_enviado_at para no duplicar. Set-based + idempotente. La corre
-- el cron cron-recordatorios cada 15 min (service_role).
--
-- La hora se muestra en la zona horaria de la SEDE del recurso (fallback MX).
-- ============================================================================

-- Marca de dedup (una sola notificación por reserva).
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS recordatorio_enviado_at timestamptz;

-- Índice parcial para el barrido (solo las pendientes de recordar).
CREATE INDEX IF NOT EXISTS reservas_recordatorio_pendiente_idx
  ON reservas (slot_inicio)
  WHERE status = 'confirmada' AND recordatorio_enviado_at IS NULL;

CREATE OR REPLACE FUNCTION generar_recordatorios_reservas()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH marcadas AS (
    UPDATE reservas res
    SET recordatorio_enviado_at = now()
    FROM recursos rc
    LEFT JOIN sucursales su ON su.id = rc.sucursal_id
    WHERE res.recurso_id = rc.id
      AND res.status = 'confirmada'
      AND res.recordatorio_enviado_at IS NULL
      AND res.slot_inicio >  now() + interval '45 minutes'
      AND res.slot_inicio <= now() + interval '75 minutes'
    RETURNING res.id, res.tenant_id, res.usuario_id, res.slot_inicio,
              rc.nombre AS recurso_nombre, su.timezone AS tz
  ),
  insertadas AS (
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    SELECT
      m.tenant_id, m.usuario_id, 'recordatorio_clase', 'Tu clase es pronto',
      'Tu reserva de ' || COALESCE(m.recurso_nombre, 'tu clase') || ' es a las '
        || to_char(m.slot_inicio AT TIME ZONE COALESCE(m.tz, 'America/Mexico_City'), 'HH24:MI')
        || '. ¡Te esperamos!',
      jsonb_build_object('reserva_id', m.id, 'slot_inicio', m.slot_inicio)
    FROM marcadas m
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM insertadas;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION generar_recordatorios_reservas() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION generar_recordatorios_reservas() TO service_role;

-- ── Verificación (devuelve tabla) ──
SELECT 'columna recordatorio_enviado_at existe' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'reservas' AND column_name = 'recordatorio_enviado_at') AS ok
UNION ALL
SELECT 'función generar_recordatorios_reservas existe',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'generar_recordatorios_reservas')
UNION ALL
SELECT 'NO ejecutable por authenticated',
       NOT has_function_privilege('authenticated', 'generar_recordatorios_reservas()', 'EXECUTE')
UNION ALL
SELECT 'ejecutable por service_role',
       has_function_privilege('service_role', 'generar_recordatorios_reservas()', 'EXECUTE');
