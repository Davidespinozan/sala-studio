-- ============================================================================
-- FIX — el bloqueo por inasistencia se puede APAGAR de verdad
-- ----------------------------------------------------------------------------
-- Ajustes → Reglas deja poner "Bloqueo por no llegar (días)" en 0, pero el cron
-- lo ignoraba: hacía GREATEST(bloqueado_hasta, now + 0 días) = AHORA, y encima
-- le mandaba al socio el aviso "no vas a poder reservar hasta el <hoy>" — un
-- mensaje sin sentido para un bloqueo que no existe.
--
-- Con 0 días: la inasistencia SE REGISTRA igual (es historia real y afecta el %
-- de asistencia), pero no hay bloqueo ni amenaza en el aviso.
--
-- Esto importa porque el default es 7 DÍAS y ningún gym nuevo lo elige a
-- conciencia: si el gym no hace check-in religiosamente, el cron le bloquea a
-- todos sus socios una semana por clases a las que SÍ fueron.
-- ============================================================================

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
      7
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
GRANT EXECUTE ON FUNCTION marcar_no_shows() TO service_role;

-- ============================================================================
-- SELF-TEST
-- ============================================================================
WITH checks AS (
  SELECT 'con 0 días NO bloquea (respeta la regla del gym)' AS prueba,
         (SELECT pg_get_functiondef(oid) LIKE '%IF v_bloqueo_dias > 0 THEN%'
            FROM pg_proc WHERE proname = 'marcar_no_shows' LIMIT 1) AS ok
  UNION ALL
  SELECT 'la inasistencia se registra igual (historia real)',
         (SELECT pg_get_functiondef(oid) LIKE '%UPDATE reservas SET status = ''no_show''%'
            FROM pg_proc WHERE proname = 'marcar_no_shows' LIMIT 1)
  UNION ALL
  SELECT 'sin bloqueo, el aviso no amenaza con una fecha',
         (SELECT pg_get_functiondef(oid) LIKE '%cancelá con tiempo para liberar el lugar%'
            FROM pg_proc WHERE proname = 'marcar_no_shows' LIMIT 1)
)
SELECT CASE WHEN ok THEN '✅' ELSE '❌' END AS estado, prueba
FROM checks
ORDER BY ok, prueba;
