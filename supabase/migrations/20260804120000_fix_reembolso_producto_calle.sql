-- ── FIX: reembolsar una venta de Tienda "a la calle" (sin socio) ────────────
--
-- Bug: una venta de producto en el POS puede no tener socio (usuario_id NULL,
-- permitido por `pagos_usuario_requerido` que exime 'producto'/'otro'). Al
-- devolverla, `registrar_reembolso` inserta el asiento negativo HEREDANDO el
-- usuario_id del cobro original (NULL) pero con concepto='reembolso', que el
-- CHECK NO eximía → la RPC fallaba con error genérico.
--
-- Fix: eximir también 'reembolso' de la obligación de socio. Un reembolso hereda
-- el socio del cobro que revierte: si el original tenía socio, el reembolso
-- también (el CHECK no lo prohíbe, solo deja de EXIGIRLO); si era a la calle,
-- queda NULL como el original. La membresía (plan/inscripción/paquete) sigue
-- exigiendo socio.

ALTER TABLE pagos DROP CONSTRAINT IF EXISTS pagos_usuario_requerido;
ALTER TABLE pagos ADD CONSTRAINT pagos_usuario_requerido
  CHECK (usuario_id IS NOT NULL OR concepto IN ('producto', 'otro', 'reembolso'));

-- ── Self-test (devuelve TABLA) ──────────────────────────────────────────────
SELECT
  'reembolso sin socio permitido' AS prueba,
  pg_get_constraintdef(oid)       AS definicion,
  (position('reembolso' IN pg_get_constraintdef(oid)) > 0) AS pasa
FROM pg_constraint
WHERE conname = 'pagos_usuario_requerido';