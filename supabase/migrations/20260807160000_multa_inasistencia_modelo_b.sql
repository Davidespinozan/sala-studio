-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- MULTA AUTOMÁTICA POR FALTAR (Modelo B)
-- ────────────────────────────────────────────────────────────────────────────
-- Algunos gyms quieren cobrar multa por NO cancelar y NO asistir, aunque el socio
-- no vuelva a reservar. Es distinto del Modelo A (multa para re-reservar el mismo
-- día). Aquí la multa se genera SOLA cuando el cron marca el no-show.
--
-- Toggles INDEPENDIENTES en config.penalizaciones:
--   Modelo A: multa_rereserva_activa    / multa_rereserva_centavos
--   Modelo B: multa_inasistencia_activa / multa_inasistencia_centavos  (default 7500)
-- Un gym puede prender A, B, los dos, o ninguno. Modelo B apagado por default:
-- nada cambia hasta que se prenda en Ajustes → Reglas.
--
-- La multa vive en la MISMA reserva (reservas.multa_centavos), así el cobro en
-- recepción (cobrar_multa_reserva) y el ledger `pagos` ya funcionan sin cambios.
-- Si la reserva YA traía multa (p. ej. una de Modelo A), no se pisa.
--
-- El aviso push (notificaciones) que ya salía por el no-show ahora menciona la
-- multa cuando aplica — sin canal nuevo.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION marcar_no_shows()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reservas_afectadas integer := 0;
  v_usuarios_bloqueados integer := 0;
  v_multas_generadas integer := 0;
  v_now timestamptz := now();
  v_bloqueo_dias integer;
  v_bloqueado_hasta timestamptz;
  v_multa_activa boolean;
  v_multa_centavos integer;
  v_multa_aplicada boolean;
  v_multa_texto text;
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

    -- Modelo B: multa automática por faltar.
    v_multa_activa := COALESCE(
      (r.tenant_config->'penalizaciones'->>'multa_inasistencia_activa')::boolean, false);
    v_multa_centavos := COALESCE(
      (r.tenant_config->'penalizaciones'->>'multa_inasistencia_centavos')::integer, 7500);

    UPDATE reservas SET status = 'no_show' WHERE id = r.id;
    v_reservas_afectadas := v_reservas_afectadas + 1;

    PERFORM _registrar_no_show_ledger(r.id, NULL);

    -- Estampar la multa (solo si el Modelo B está activo y la reserva NO trae ya
    -- una multa — p. ej. una de Modelo A no se pisa).
    v_multa_aplicada := false;
    IF v_multa_activa AND v_multa_centavos > 0 THEN
      UPDATE reservas
      SET multa_centavos = v_multa_centavos, multa_pagada = false
      WHERE id = r.id AND COALESCE(multa_centavos, 0) = 0;
      IF FOUND THEN
        v_multa_aplicada := true;
        v_multas_generadas := v_multas_generadas + 1;
      END IF;
    END IF;

    v_multa_texto := CASE
      WHEN v_multa_aplicada
        THEN ' Se generó una multa de $' || (v_multa_centavos / 100)::text
             || ' que se cobra en recepción.'
      ELSE ''
    END;

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
          || '). No vas a poder reservar hasta el ' || to_char(v_bloqueado_hasta, 'DD/MM') || '.'
          || v_multa_texto,
        jsonb_build_object('reserva_id', r.id, 'bloqueado_hasta', v_bloqueado_hasta,
                           'multa_centavos', CASE WHEN v_multa_aplicada THEN v_multa_centavos ELSE 0 END)
      );
    ELSE
      -- El gym eligió NO bloquear. La falta se registra; el aviso solo informa
      -- (y menciona la multa si el Modelo B la generó).
      INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
      VALUES (
        r.tenant_id, r.usuario_id, 'no_show',
        'No asististe a tu clase',
        'Se registró una inasistencia (' || COALESCE(r.folio, 'reserva')
          || ').' || CASE WHEN v_multa_aplicada THEN '' ELSE ' Si no vas a poder ir, cancela con tiempo para liberar el lugar.' END
          || v_multa_texto,
        jsonb_build_object('reserva_id', r.id,
                           'multa_centavos', CASE WHEN v_multa_aplicada THEN v_multa_centavos ELSE 0 END)
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'reservas_afectadas', v_reservas_afectadas,
    'usuarios_bloqueados', v_usuarios_bloqueados,
    'multas_generadas', v_multas_generadas,
    'timestamp', v_now
  );
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA. Smoke test seguro: NO llama a marcar_no_shows() (procesa
-- TODOS los tenants), solo confirma que la función desplegada ya trae la lógica de
-- Modelo B y que la multa vive en reservas. El flujo real lo corre el cron.
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  'multa inasistencia (Modelo B)' AS prueba,
  pg_get_functiondef('marcar_no_shows'::regproc) LIKE '%multa_inasistencia_activa%' AS logica_b_ok,
  pg_get_functiondef('marcar_no_shows'::regproc) LIKE '%multas_generadas%'          AS retorno_ok,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='reservas' AND column_name='multa_centavos')             AS col_multa_ok;