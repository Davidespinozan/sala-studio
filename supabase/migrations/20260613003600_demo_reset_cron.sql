-- ============================================================================
-- Reset nocturno del DEMO: limpia la actividad transaccional que dejan los
-- visitantes en sala-demo, sin tocar el seed viejo ni la cuenta demo.
-- ----------------------------------------------------------------------------
-- Borra lo creado en las últimas 25h (reservas, lista de espera, movimientos de
-- crédito, membresías, notificaciones y socios nuevos). El seed original (más
-- viejo) sobrevive, así los reportes siguen mostrando datos. La estructura
-- (marca/planes/salas/parrilla) está protegida por los guardrails, no cambia.
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
  -- Socios creados por visitantes (no toca al admin demo ni a los del seed viejo).
  DELETE FROM usuarios WHERE tenant_id = v_demo AND rol = 'miembro' AND created_at > v_corte;
END;
$$;

COMMENT ON FUNCTION reset_sala_demo() IS
  'Limpia la actividad transaccional de sala-demo de las últimas 25h (visitantes del demo). Programada de noche vía pg_cron.';

-- Programar el reset diario (08:00 UTC ≈ madrugada en México). Idempotente.
DO $$
BEGIN
  PERFORM cron.unschedule('reset-sala-demo');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

SELECT cron.schedule('reset-sala-demo', '0 8 * * *', $$SELECT reset_sala_demo()$$);
