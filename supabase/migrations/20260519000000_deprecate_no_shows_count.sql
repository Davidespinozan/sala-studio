-- =============================================================================
-- DEPRECATE usuarios.no_shows_count
-- =============================================================================
-- A partir de S3c (Eje 4) la UI consume el conteo de no-shows directamente
-- desde reservas.status='no_show' (ver src/admin/hooks/useMiembroKPIs.ts), que
-- es la única fuente de verdad correcta. La columna usuarios.no_shows_count
-- queda sin mantenimiento garantizado y NO debe usarse para decisiones nuevas.
--
-- No se dropea ahora: pueden existir reglas operativas, RPCs o jobs legacy que
-- todavía lean este contador. Considerar drop en un sprint futuro luego de
-- auditar referencias (`grep -r no_shows_count`).
-- =============================================================================

COMMENT ON COLUMN usuarios.no_shows_count IS
  'DEPRECATED (S3c, 2026-05-19): este contador no se mantiene actualizado. '
  'Usar reservas.status=''no_show'' como única fuente de verdad. '
  'Considerar drop en sprint futuro tras auditar referencias.';
