-- ============================================================================
-- S4.3 — Cron nightly: regenerar-clases (mantiene 60 días de lookhead)
-- ============================================================================
-- Programa la Edge Function `regenerar-clases` para correr cada noche a las
-- 03:00 UTC vía pg_cron + pg_net.
--
-- REQUISITOS para que el job funcione (ver supabase/functions/regenerar-clases/README.md):
--   1. La Edge Function `regenerar-clases` debe estar deployada.
--   2. El service_role_key debe estar guardado en Supabase Vault con
--      name = 'service_role_key'. El job lee de vault.decrypted_secrets para
--      armar el header Authorization (verify_jwt del runtime queda en default).
--
-- Si el secret de Vault no existe, el job igual se registra pero las corridas
-- devolverán 401 hasta que se agregue. No rompe la migración.
--
-- Idempotente: se desregistra el job previo antes de re-crearlo.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Quitar el job previo si existe (re-runs de la migración / cambios de schedule).
SELECT cron.unschedule('regenerar-clases-nightly')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'regenerar-clases-nightly'
);

-- Programar: 03:00 UTC todos los días.
SELECT cron.schedule(
  'regenerar-clases-nightly',
  '0 3 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://omrlbvhbggnrwwzlgxji.supabase.co/functions/v1/regenerar-clases',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || COALESCE(
        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
        ''
      )
    ),
    body := '{}'::jsonb
  );
  $job$
);

-- Verificación rápida del registro (NOTICE, no falla la migración).
DO $$
DECLARE
  v_existe boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'regenerar-clases-nightly')
    INTO v_existe;
  IF v_existe THEN
    RAISE NOTICE 'Cron job regenerar-clases-nightly registrado (03:00 UTC diario).';
  ELSE
    RAISE WARNING 'No se pudo registrar el cron job regenerar-clases-nightly.';
  END IF;
END $$;
