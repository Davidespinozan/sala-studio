-- ============================================================================
-- Habilita Supabase Realtime en `notificaciones`.
-- ----------------------------------------------------------------------------
-- El hook useNotificaciones se suscribe a INSERT/UPDATE filtrado por usuario_id
-- para que las notificaciones aparezcan al instante (sin esperar el poll de 30s).
-- La RLS de la tabla ya limita lo que cada usuario recibe.
--
--   - Agrega la tabla a la publicación `supabase_realtime` (idempotente).
--   - REPLICA IDENTITY FULL: hace que el filtro por usuario_id funcione también
--     en UPDATE/DELETE (no solo INSERT). Tabla de bajo volumen → costo despreciable.
-- Si Realtime no estuviera habilitado, el polling sigue cubriendo: nada se rompe.
-- ============================================================================

ALTER TABLE notificaciones REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notificaciones'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE notificaciones;
  END IF;
END $$;
