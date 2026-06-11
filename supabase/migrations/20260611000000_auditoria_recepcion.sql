-- ============================================================================
-- Bitácora de auditoría de Recepción  (D-021 · Rediseño Recepción · Ola 1)
-- ----------------------------------------------------------------------------
-- Tabla append-only. Nace VACÍA: las acciones que escriben llegan en el
-- Sub-round 2 (RPCs SECURITY DEFINER). Mismo patrón que membresia_movimientos.
--
-- TRES MURALLAS:
--   1. RLS: solo ADMIN del tenant LEE. Sin policy de escritura → ningún cliente
--      inserta/actualiza/borra. (Los RPC SECURITY DEFINER bypassean RLS.)
--   2. Trigger BEFORE UPDATE → bloquea TODO update (incluido service_role).
--   3. Trigger BEFORE DELETE → bloquea el DELETE directo (depth 1). Permite el
--      DELETE en cascada del cierre de un tenant (depth > 1, vía el trigger RI
--      de la FK). pg_trigger_depth() distingue uno de otro.
-- El test del final verifica esas 3 murallas + que un SECURITY DEFINER SÍ puede
-- escribir (muralla 4 — el patrón que usarán los RPC del Sub-round 2).
--
-- Enum de acciones con CHECK en la DB (rigor de auditoría). Incluye los
-- check-ins desde ya para no re-migrar el CHECK cuando, en Sub-round 2,
-- check_in_atomic / check_in_manual_atomic empiecen a escribir acá.
-- ============================================================================

CREATE TABLE IF NOT EXISTS auditoria_recepcion (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Quién (current_user). Snapshot de nombre/rol → el log sobrevive si luego
  -- se borra/renombra al staff (FK con SET NULL, snapshot intacto).
  actor_id      uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  actor_nombre  text NOT NULL,
  actor_rol     text NOT NULL CHECK (actor_rol IN ('recepcionista','admin')),

  -- Qué acción — vocabulario cerrado "entidad.verbo" (CHECK rígido).
  accion text NOT NULL CHECK (accion IN (
    'membresia.renovar','membresia.cambiar_plan','membresia.recargar_creditos',
    'membresia.congelar','membresia.reactivar','membresia.cancelar',
    'reserva.crear','reserva.cancelar','reserva.lista_espera_anotar','reserva.lista_espera_promover',
    'socio.crear','socio.editar_contacto','socio.reset_password','socio.bloquear','socio.desbloquear','socio.nota',
    'clase.crear','clase.cancelar','clase.reasignar_coach','clase.marcar_asistencia','clase.marcar_no_show',
    'pago.reenviar_link','pago.activar',
    'checkin.manual','checkin.qr'
  )),
  entidad     text CHECK (entidad IN ('membresia','reserva','socio','clase','pago','checkin')),
  entidad_id  uuid,

  -- Socio afectado (nullable: cancelar clase afecta a muchos). Snapshot nombre.
  socio_id      uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  socio_nombre  text,

  resumen   text  NOT NULL,   -- one-liner humano ("Renovó plan de Juan: +30 días…")
  detalle   jsonb,            -- { antes:{…}, despues:{…}, extra:{…} }

  creado_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audrec_tenant_fecha ON auditoria_recepcion (tenant_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_audrec_actor  ON auditoria_recepcion (tenant_id, actor_id);
CREATE INDEX IF NOT EXISTS idx_audrec_socio  ON auditoria_recepcion (tenant_id, socio_id);
CREATE INDEX IF NOT EXISTS idx_audrec_accion ON auditoria_recepcion (tenant_id, accion);

COMMENT ON TABLE auditoria_recepcion IS
  'Bitácora append-only de acciones de recepción/admin (D-021). Solo RPCs SECURITY DEFINER escriben; nunca clientes. UPDATE bloqueado por trigger; DELETE directo bloqueado por trigger (permite solo el cascade del cierre de tenant). Solo admin lee (RLS).';

-- ── Muralla 1: RLS — solo admin del tenant LEE. Sin policy de escritura. ──
ALTER TABLE auditoria_recepcion ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audrec_read_admin ON auditoria_recepcion;
CREATE POLICY audrec_read_admin ON auditoria_recepcion
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin());

-- ── Muralla 2: append-only — bloquear UPDATE (igual que membresia_movimientos) ──
CREATE OR REPLACE FUNCTION trg_audrec_no_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'auditoria_recepcion es append-only: UPDATE no permitido';
END;
$$;

DROP TRIGGER IF EXISTS audrec_no_update ON auditoria_recepcion;
CREATE TRIGGER audrec_no_update
  BEFORE UPDATE ON auditoria_recepcion
  FOR EACH ROW EXECUTE FUNCTION trg_audrec_no_update();

-- ── Muralla 3: bloquear DELETE directo, permitir el cascade del tenant ──
-- ON DELETE CASCADE SÍ dispara este BEFORE DELETE. Distinguimos por profundidad:
--   DELETE directo             → pg_trigger_depth() = 1 → BLOQUEAR
--   DELETE en cascada (tenant) → pg_trigger_depth() > 1 → PERMITIR
CREATE OR REPLACE FUNCTION trg_audrec_no_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;  -- cascade desde el borrado del tenant → permitido
  END IF;
  RAISE EXCEPTION 'auditoria_recepcion es append-only: DELETE directo no permitido';
END;
$$;

DROP TRIGGER IF EXISTS audrec_no_delete ON auditoria_recepcion;
CREATE TRIGGER audrec_no_delete
  BEFORE DELETE ON auditoria_recepcion
  FOR EACH ROW EXECUTE FUNCTION trg_audrec_no_delete();

-- ============================================================================
-- TEST de las murallas. Si alguna falla, ABORTA la migración (fail-safe).
--
-- Detalles del diseño del test (por las 3 observaciones de la revisión):
--  · No se usa `WHEN others` (enmascara el motivo → falso positivo). Cada test
--    atrapa SOLO la excepción ESPERADA; cualquier otra burbujea y aborta.
--      - Muralla 1 (RLS/grant)   → SQLSTATE 42501 = insufficient_privilege
--      - Murallas 2/3 (triggers)  → raise_exception cuyo mensaje sea 'append-only'
--  · Se agrega la muralla 4: un SECURITY DEFINER SÍ puede insertar (el patrón
--    que usarán los RPC del Sub-round 2). Si eso no funcionara, mejor saberlo ya.
--  · Las filas de prueba se revierten con una SUBTRANSACCIÓN de plpgsql
--    (BEGIN…EXCEPTION = savepoint implícito) + excepción centinela. NO se
--    desactiva ningún trigger (evita dejar la tabla desprotegida si algo falla).
--    Nota: SAVEPOINT/ROLLBACK explícitos no se permiten dentro de un DO/plpgsql.
--  · El helper SECURITY DEFINER de la muralla 4 va TOP-LEVEL (CREATE FUNCTION no
--    es válido dentro de un DO) con GRANT EXECUTE a authenticated, y se dropea al
--    final. El SQL Editor de Supabase corre TODO el script en UNA transacción
--    (protocolo simple de Postgres: varias sentencias en un string = una sola
--    transacción salvo BEGIN/COMMIT explícitos): si el DO aborta, el CREATE
--    FUNCTION se revierte con él → sin helper huérfano, sin BEGIN explícito.
--  · El SQL Editor corre como OWNER (saltea RLS) → la muralla 1 cambia de rol a
--    'authenticated' (un INSERT como owner daría falso OK).
-- ============================================================================

-- Helper SECURITY DEFINER para la muralla 4 (top-level; se dropea al final).
CREATE OR REPLACE FUNCTION _audrec_test_definer(p_tenant uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $f$
DECLARE r uuid;
BEGIN
  INSERT INTO auditoria_recepcion (tenant_id, actor_nombre, actor_rol, accion, resumen)
  VALUES (p_tenant, 'TEST-DEFINER', 'admin', 'checkin.qr', 'insert vía security definer')
  RETURNING id INTO r;
  RETURN r;
END;
$f$;

GRANT EXECUTE ON FUNCTION _audrec_test_definer(uuid) TO authenticated;

DO $$
DECLARE
  v_tenant uuid;
  v_id     uuid;
  v_def_id uuid;
  v_count  int;
  v_blocked boolean;
BEGIN
  SELECT id INTO v_tenant FROM tenants LIMIT 1;
  IF v_tenant IS NULL THEN
    RAISE NOTICE 'TEST: no hay tenants — salto los tests (la tabla y triggers quedaron creados).';
    RETURN;
  END IF;

  -- ── Muralla 1 (RLS): un usuario 'authenticated' NO puede insertar ──
  -- Solo se atrapa insufficient_privilege (42501 = RLS o falta de grant). Otra
  -- excepción NO se atrapa → burbujea (nada de falso OK).
  v_blocked := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO auditoria_recepcion (tenant_id, actor_nombre, actor_rol, accion, resumen)
    VALUES (v_tenant, 'HACK', 'admin', 'checkin.manual', 'no debería entrar');
  EXCEPTION WHEN insufficient_privilege THEN
    v_blocked := true;
  END;
  RESET ROLE;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'TEST FALLÓ (muralla 1): un usuario authenticated pudo INSERT.';
  END IF;

  -- ── Murallas 2, 3 y 4 dentro de una subtransacción que se revierte al final
  --    (las filas de prueba desaparecen sin tocar los triggers). ──
  BEGIN
    -- fila de prueba (owner, bypassa RLS) para murallas 2 y 3
    INSERT INTO auditoria_recepcion (tenant_id, actor_id, actor_nombre, actor_rol, accion, resumen)
    VALUES (v_tenant, NULL, 'TEST', 'admin', 'checkin.manual', 'fila de prueba')
    RETURNING id INTO v_id;

    -- Muralla 2 (UPDATE bloqueado por el trigger append-only)
    v_blocked := false;
    BEGIN
      UPDATE auditoria_recepcion SET resumen = 'hack' WHERE id = v_id;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE '%append-only%' THEN v_blocked := true; ELSE RAISE; END IF;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'TEST FALLÓ (muralla 2): el UPDATE no fue bloqueado.';
    END IF;

    -- Muralla 3 (DELETE directo bloqueado, depth 1)
    v_blocked := false;
    BEGIN
      DELETE FROM auditoria_recepcion WHERE id = v_id;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE '%append-only%' THEN v_blocked := true; ELSE RAISE; END IF;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'TEST FALLÓ (muralla 3): el DELETE directo no fue bloqueado.';
    END IF;

    -- Muralla 4 (SECURITY DEFINER SÍ inserta). La llamamos como 'authenticated'
    -- (simula un cliente llamando a un RPC) — la función corre como owner.
    SET LOCAL ROLE authenticated;
    v_def_id := _audrec_test_definer(v_tenant);
    RESET ROLE;
    SELECT count(*) INTO v_count FROM auditoria_recepcion WHERE id = v_def_id;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'TEST FALLÓ (muralla 4): un SECURITY DEFINER no pudo insertar.';
    END IF;

    -- Revertir las filas de prueba: excepción centinela → rollback de la subtx.
    RAISE EXCEPTION 'ROLLBACK_TEST_DATA';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'ROLLBACK_TEST_DATA' THEN
      NULL;   -- ok: la subtransacción y sus filas de prueba se revirtieron
    ELSE
      RAISE;  -- un 'TEST FALLÓ …' real (u otra excepción) → aborta la migración
    END IF;
  END;

  RAISE NOTICE 'TEST OK ✔ muralla 1 (RLS bloquea INSERT de authenticated) · muralla 2 (UPDATE bloqueado) · muralla 3 (DELETE directo bloqueado) · muralla 4 (SECURITY DEFINER sí inserta) · filas de prueba revertidas.';
END $$;

-- Limpieza del helper de test (top-level; tras el DO).
DROP FUNCTION IF EXISTS _audrec_test_definer(uuid);
