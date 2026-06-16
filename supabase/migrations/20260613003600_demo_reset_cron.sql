-- ============================================================================
-- Reset nocturno del DEMO: limpia a los visitantes anónimos y su actividad en
-- sala-demo, sin tocar el seed viejo.
-- ----------------------------------------------------------------------------
-- Borra lo creado en las últimas 25h: actividad transaccional (reservas, lista
-- de espera, créditos, membresías, notificaciones) + las filas de usuario de los
-- visitantes anónimos y de socios que hayan creado. El seed original (más viejo)
-- sobrevive, así los reportes siguen con datos. La estructura está protegida por
-- los guardrails.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION reset_sala_demo()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_demo uuid;
  v_corte timestamptz := now() - interval '25 hours';
BEGIN
  SELECT id INTO v_demo FROM tenants WHERE slug = 'sala-demo';
  IF v_demo IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM notificaciones        WHERE tenant_id = v_demo AND creada_at  > v_corte;
  DELETE FROM lista_espera          WHERE tenant_id = v_demo AND created_at > v_corte;
  DELETE FROM membresia_movimientos WHERE tenant_id = v_demo AND created_at > v_corte;
  DELETE FROM reservas              WHERE tenant_id = v_demo AND created_at > v_corte;
  DELETE FROM membresias            WHERE tenant_id = v_demo AND created_at > v_corte;

  -- Visitantes anónimos del demo + socios creados por visitantes (recientes).
  -- Borrar la fila de usuario cascada su data restante (reservas/membresías).
  DELETE FROM usuarios u
  WHERE u.tenant_id = v_demo
    AND u.created_at > v_corte
    AND (u.rol = 'miembro'
         OR u.auth_id IN (SELECT id FROM auth.users WHERE is_anonymous = true));
END;
$$;

COMMENT ON FUNCTION reset_sala_demo() IS
  'Limpia visitantes anónimos del demo y su actividad transaccional (sala-demo, últimas 25h). Programada de noche vía pg_cron.';

-- Programar el reset diario (08:00 UTC ≈ madrugada en México). Idempotente.
DO $$
BEGIN
  PERFORM cron.unschedule('reset-sala-demo');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

SELECT cron.schedule('reset-sala-demo', '0 8 * * *', $$SELECT reset_sala_demo()$$);
