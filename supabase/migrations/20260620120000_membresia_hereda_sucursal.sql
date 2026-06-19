-- ============================================================================
-- La membresía hereda la sede del socio (Fase 7 multi-sucursal)
-- ----------------------------------------------------------------------------
-- En el alta, el socio elige su sede (usuarios.sucursal_id, vía signup). Para
-- que el alcance por sede (Fase 6) funcione sin tener que tocar cada RPC que
-- crea membresías (gestionar_membresia_socio, activar_suscripcion_socio,
-- provisionar_demo, futuro webhook de Stripe), un trigger BEFORE INSERT rellena
-- membresias.sucursal_id con la sede "home" del socio cuando no viene explícita.
-- ============================================================================

CREATE OR REPLACE FUNCTION membresia_hereda_sucursal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sucursal_id IS NULL THEN
    SELECT sucursal_id INTO NEW.sucursal_id FROM usuarios WHERE id = NEW.usuario_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_membresia_hereda_sucursal ON membresias;
CREATE TRIGGER trg_membresia_hereda_sucursal
  BEFORE INSERT ON membresias
  FOR EACH ROW EXECUTE FUNCTION membresia_hereda_sucursal();
