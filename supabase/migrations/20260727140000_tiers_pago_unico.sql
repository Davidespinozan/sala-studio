-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- PLAN "PAGO ÚNICO" — un plan por tiempo que NO es una suscripción autorenovable.
-- ────────────────────────────────────────────────────────────────────────────
-- "Mensualidad" daba a entender que se cobra solo cada periodo (suscripción). Un
-- gym que cobra en recepción (numa) vende ACCESO por un tiempo, de pago único:
-- el socio paga una vez, entra hasta que vence, y si quiere más vuelve a pagar en
-- mostrador. No hay auto-cobro.
--
-- Este flag NO cambia la vigencia ni el acceso (eso lo maneja duracion_dias). Es
-- para (1) que el formulario/UI lo digan claro ("pago único", no "cobro mensual")
-- y (2) más adelante, reportes que no cuenten a un comprador de pago único como
-- churn de suscripción. Default false = los planes actuales no cambian.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE tiers
  ADD COLUMN IF NOT EXISTS pago_unico boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tiers.pago_unico IS
  'true = plan por tiempo de PAGO ÚNICO (no autorenovable): el socio paga una vez por su acceso y renueva volviendo a pagar (en recepción). false = mensualidad/suscripción. Solo afecta redacción y reportes; la vigencia la manda duracion_dias.';

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA.
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  'columna tiers.pago_unico existe' AS prueba,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tiers' AND column_name = 'pago_unico'
  ) AS ok_existe,
  (SELECT column_default FROM information_schema.columns
   WHERE table_name = 'tiers' AND column_name = 'pago_unico') AS default_esperado_false;
