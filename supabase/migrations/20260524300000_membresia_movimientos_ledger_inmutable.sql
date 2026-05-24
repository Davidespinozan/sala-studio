-- ============================================================================
-- Membresías Prepago — ledger inmutable: drop FK reserva_id + created_by
-- ============================================================================
-- BUG DESCUBIERTO — la tabla membresia_movimientos tenía dos FKs con
-- ON DELETE SET NULL:
--   - reserva_id  REFERENCES reservas(id) ON DELETE SET NULL
--   - created_by  REFERENCES usuarios(id) ON DELETE SET NULL
--
-- Cuando Postgres procesa el cascade de borrar una reserva o un usuario,
-- ejecuta internamente un UPDATE membresia_movimientos SET <col>=NULL. Ese
-- UPDATE choca con el trigger BEFORE UPDATE `trg_membresia_mov_no_update`
-- (append-only) y la operación entera aborta. Consecuencia:
--   - no se puede borrar una reserva con movimientos asociados
--   - no se puede borrar un usuario que escribió movimientos
--   - no se puede borrar un TENANT entero (sus cascades disparan los anteriores)
--
-- DECISIÓN — drop ambas FKs, mantener las columnas como uuid sueltos. Es la
-- convención canónica para ledgers de auditoría inmutables (Stripe events,
-- contabilidad doble-entrada, sistemas bancarios): el registro histórico
-- preserva la referencia AUNQUE la entidad externa desaparezca. "El socio
-- consumió 1 crédito por la reserva X" sigue siendo verdadero como hecho
-- histórico aunque la reserva X después se borre.
--
-- TRADE-OFF — perdemos la integridad referencial al nivel de constraint.
-- Mitigación: en cualquier query que necesite la reserva o el usuario,
-- LEFT JOIN (no INNER JOIN) y manejar NULL cuando la entidad ya no exista.
-- El índice `idx_membresia_mov_reserva` se preserva — sigue siendo útil para
-- queries del tipo "todos los movimientos vinculados a la reserva X".
--
-- POR QUÉ NO LAS OTRAS OPCIONES:
--   - Trigger que permite SET NULL en cascade: viola la inmutabilidad del
--     ledger (una fila puede cambiar, perdés "lo que leí ayer es lo de hoy").
--   - FK con NO ACTION (bloquear borrados): rompe administraciones legítimas
--     (borrar tenants, limpiar mocks, tests, seeds).
--   - FK con CASCADE DELETE: borra el movimiento si se borra la reserva →
--     se pierde el dato histórico, no se puede auditar después.
--
-- ROBUSTEZ — el DROP usa pg_constraint por conkey (no por nombre hardcodeado),
-- igual que el patrón paranoia del status CHECK de Fase 1.
-- ============================================================================

DO $$
DECLARE
  v_attnum smallint;
  v_name text;
BEGIN
  -- ── Drop FK de reserva_id ──
  SELECT attnum INTO v_attnum
  FROM pg_attribute
  WHERE attrelid = 'membresia_movimientos'::regclass
    AND attname = 'reserva_id'
    AND NOT attisdropped;

  SELECT conname INTO v_name
  FROM pg_constraint
  WHERE conrelid = 'membresia_movimientos'::regclass
    AND contype = 'f'
    AND conkey = ARRAY[v_attnum]::int2[]
  LIMIT 1;

  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE membresia_movimientos DROP CONSTRAINT %I', v_name);
    RAISE NOTICE 'Dropped FK reserva_id: %', v_name;
  ELSE
    RAISE NOTICE 'FK reserva_id no encontrada (ya estaba removida)';
  END IF;

  -- ── Drop FK de created_by ──
  SELECT attnum INTO v_attnum
  FROM pg_attribute
  WHERE attrelid = 'membresia_movimientos'::regclass
    AND attname = 'created_by'
    AND NOT attisdropped;

  SELECT conname INTO v_name
  FROM pg_constraint
  WHERE conrelid = 'membresia_movimientos'::regclass
    AND contype = 'f'
    AND conkey = ARRAY[v_attnum]::int2[]
  LIMIT 1;

  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE membresia_movimientos DROP CONSTRAINT %I', v_name);
    RAISE NOTICE 'Dropped FK created_by: %', v_name;
  ELSE
    RAISE NOTICE 'FK created_by no encontrada (ya estaba removida)';
  END IF;
END $$;

-- ── Actualizar comentarios para reflejar la decisión ──

COMMENT ON COLUMN membresia_movimientos.reserva_id IS
  'UUID histórico de la reserva que originó este movimiento. NO es FK: el ledger es append-only e inmutable, debe preservar el evento aunque la reserva luego se borre. Queries que necesiten la reserva: LEFT JOIN reservas (devuelve NULL si fue borrada).';

COMMENT ON COLUMN membresia_movimientos.created_by IS
  'UUID histórico del usuario admin/recepción que escribió el movimiento (NULL si lo escribió un RPC SECURITY DEFINER sin contexto de sesión). NO es FK por la misma razón que reserva_id: preservar la traza aunque el usuario después se borre.';

COMMENT ON TABLE membresia_movimientos IS
  'Ledger append-only e inmutable de movimientos de crédito por membresía. Solo se escribe vía RPCs SECURITY DEFINER; nunca por clientes. UPDATE bloqueado por trigger absoluto. DELETE solo en cascade desde membresias (que cascade desde tenants). reserva_id y created_by son uuids sueltos sin FK por inmutabilidad — ver columnas para detalle.';

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================

DO $$
DECLARE
  v_fks_remaining integer;
  v_orphans_reserva integer;
  v_orphans_created_by integer;
BEGIN
  -- Confirmar que las FKs no constraint-existen más
  SELECT count(*) INTO v_fks_remaining
  FROM pg_constraint
  WHERE conrelid = 'membresia_movimientos'::regclass
    AND contype = 'f'
    AND conname IN (
      SELECT conname FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conrelid = 'membresia_movimientos'::regclass
        AND a.attname IN ('reserva_id','created_by')
    );

  -- Estado de la data actual (debería ser cero huérfanos: nadie borró todavía)
  SELECT count(*) INTO v_orphans_reserva
  FROM membresia_movimientos m
  LEFT JOIN reservas r ON r.id = m.reserva_id
  WHERE m.reserva_id IS NOT NULL AND r.id IS NULL;

  SELECT count(*) INTO v_orphans_created_by
  FROM membresia_movimientos m
  LEFT JOIN usuarios u ON u.id = m.created_by
  WHERE m.created_by IS NOT NULL AND u.id IS NULL;

  RAISE NOTICE 'Ledger inmutable OK:';
  RAISE NOTICE '  FKs reserva_id/created_by restantes: % (esperado: 0)', v_fks_remaining;
  RAISE NOTICE '  movimientos con reserva_id huérfano: %', v_orphans_reserva;
  RAISE NOTICE '  movimientos con created_by huérfano: %', v_orphans_created_by;
END $$;
