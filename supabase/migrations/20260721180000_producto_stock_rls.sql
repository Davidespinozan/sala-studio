-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- FIX: la vista `producto_stock` respeta la RLS del que consulta
-- ============================================================================
-- Una vista en Postgres corre, por default, con los permisos de su DUEÑO (el
-- rol que la creó), no del que la consulta. Como la dueña es `postgres` —que se
-- salta la RLS—, cualquier usuario autenticado que hiciera `SELECT` sobre
-- `producto_stock` veía el stock de TODOS los gyms, no solo el suyo. Es la
-- misma clase de fuga que ya apareció en la auditoría de RLS.
--
-- `security_invoker = true` hace que la vista corra con los permisos de QUIEN
-- la consulta, así se aplica la RLS de `producto_movimientos` (que ya filtra
-- por tenant). Necesita Postgres 15+; Supabase lo cumple.
-- ============================================================================

ALTER VIEW producto_stock SET (security_invoker = true);

-- ── Verificación: la vista quedó con security_invoker prendido ──────────────
SELECT
  'producto_stock' AS vista,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM pg_class
      WHERE relname = 'producto_stock'
        AND reloptions @> ARRAY['security_invoker=true']
    ) THEN 'OK — respeta la RLS del que consulta'
    ELSE '*** FALLA — sigue corriendo como su dueño ***'
  END AS resultado;