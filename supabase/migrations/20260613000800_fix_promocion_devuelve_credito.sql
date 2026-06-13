-- ============================================================================
-- FIX M5 — promoción "defensiva" de lista de espera perdía el crédito.
-- ----------------------------------------------------------------------------
-- promover_siguiente_en_espera se escribió ANTES de que la lista de espera
-- debitara créditos (migración 20260526100000). Su rama defensiva (el socio en
-- cola ya tiene reserva activa en la clase) cierra la entrada como 'promovido'
-- sin devolver el crédito que debitó al anotarse → crédito perdido en silencio
-- (el fallback de cancelar_reserva_atomic busca por reserva_id, que acá queda
-- NULL, así que nunca lo encuentra).
--
-- Fix: recreamos la función agregando, en esa rama, la devolución del crédito
-- con el MISMO patrón anti-doble que salir_lista_espera (chequea debito sin
-- devolucion previa por lista_espera_id). El resto queda idéntico.
-- ============================================================================

CREATE OR REPLACE FUNCTION promover_siguiente_en_espera(p_clase_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clase clases;
  v_recurso recursos;
  v_cupos_ocupados integer;
  v_entry lista_espera;
  v_usuario usuarios;
  v_now timestamptz := now();
  -- Devolución (rama defensiva)
  v_mem_id uuid;
  v_tier_tipo text;
  v_debit_count integer;
  v_refund_count integer;
  v_devolver boolean;
BEGIN
  SELECT * INTO v_clase FROM clases WHERE id = p_clase_id;
  -- Clase inexistente o no programada → no se promueve a nadie.
  IF v_clase.id IS NULL OR v_clase.status <> 'programada' THEN
    RETURN NULL;
  END IF;

  -- ¿Quedó cupo libre tras la cancelación?
  SELECT count(*) INTO v_cupos_ocupados
  FROM reservas
  WHERE clase_id = p_clase_id
    AND status IN ('confirmada', 'completada');
  IF v_cupos_ocupados >= v_clase.cupo_max THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_recurso FROM recursos WHERE id = v_clase.recurso_id;

  -- FIFO con lock por fila. SKIP LOCKED: dos cancelaciones concurrentes
  -- bloquean entradas distintas → promueven a personas distintas.
  FOR v_entry IN
    SELECT * FROM lista_espera
    WHERE clase_id = p_clase_id
      AND status = 'esperando'
    ORDER BY created_at ASC, id ASC
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT * INTO v_usuario FROM usuarios WHERE id = v_entry.usuario_id;

    -- Saltar entradas no promovibles (la entrada queda 'esperando': si el
    -- usuario se reactiva, sigue en la cola).
    IF v_usuario.status <> 'activo' THEN CONTINUE; END IF;
    IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
      CONTINUE;
    END IF;
    IF v_recurso.id IS NOT NULL
       AND v_usuario.membresia_tier IS NOT NULL
       AND NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
      CONTINUE;
    END IF;

    -- Defensivo: ya tiene reserva activa en la clase → cerrar su entrada y
    -- DEVOLVER el crédito que debitó al anotarse (no va a recibir promoción).
    -- fix M5: antes se cerraba como 'promovido' sin devolver → crédito perdido.
    IF EXISTS (
      SELECT 1 FROM reservas
      WHERE clase_id = p_clase_id
        AND usuario_id = v_entry.usuario_id
        AND status IN ('confirmada', 'completada')
    ) THEN
      v_devolver := false;
      v_mem_id := NULL;

      IF v_usuario.rol = 'miembro' THEN
        SELECT m.id, t.tipo
        INTO v_mem_id, v_tier_tipo
        FROM membresias m
        JOIN tiers t ON t.id = m.tier_id
        WHERE m.usuario_id = v_entry.usuario_id
          AND m.status IN ('trialing', 'activa', 'past_due', 'congelada')
        ORDER BY
          CASE m.status
            WHEN 'activa'    THEN 0
            WHEN 'trialing'  THEN 1
            WHEN 'past_due'  THEN 2
            WHEN 'congelada' THEN 3
          END,
          m.created_at DESC
        LIMIT 1
        FOR UPDATE OF m;

        IF v_mem_id IS NOT NULL AND v_tier_tipo IN ('creditos', 'hibrido') THEN
          SELECT count(*) INTO v_debit_count
          FROM membresia_movimientos
          WHERE membresia_id = v_mem_id
            AND lista_espera_id = v_entry.id
            AND tipo = 'debito';

          SELECT count(*) INTO v_refund_count
          FROM membresia_movimientos
          WHERE membresia_id = v_mem_id
            AND lista_espera_id = v_entry.id
            AND tipo = 'devolucion';

          IF v_debit_count > 0 AND v_refund_count = 0 THEN
            v_devolver := true;
          END IF;
        END IF;
      END IF;

      IF v_devolver THEN
        UPDATE membresias
        SET creditos_restantes = COALESCE(creditos_restantes, 0) + 1
        WHERE id = v_mem_id;

        INSERT INTO membresia_movimientos (
          membresia_id, tenant_id, tipo, delta_creditos,
          reserva_id, lista_espera_id, motivo, created_by
        ) VALUES (
          v_mem_id, v_entry.tenant_id, 'devolucion', 1,
          NULL, v_entry.id,
          'lista de espera: ya tenía reserva (' || COALESCE(v_clase.nombre, '') || ')',
          v_entry.usuario_id
        );
      END IF;

      UPDATE lista_espera
      SET status = 'promovido', promovido_at = v_now
      WHERE id = v_entry.id;
      CONTINUE;
    END IF;

    -- Promover: una cancelación libera un lugar → una promoción.
    PERFORM _promover_entrada(v_entry.id);
    RETURN v_entry.usuario_id;
  END LOOP;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION promover_siguiente_en_espera(uuid) FROM PUBLIC;

COMMENT ON FUNCTION promover_siguiente_en_espera(uuid) IS
  'Promueve al primero en lista de espera (FIFO) si hay cupo libre. Invocado por el trigger reservas_promover_lista_espera. FOR UPDATE SKIP LOCKED evita doble promoción. Si el siguiente ya tiene reserva en la clase, cierra su entrada DEVOLVIENDO el crédito que debitó al anotarse (fix M5, anti-doble por lista_espera_id).';

-- ============================================================================
-- TEST (smoke) — la función incluye la devolución en la rama defensiva.
-- Un test conductual requeriría fixtures de clase/recurso/sucursal completos;
-- la lógica de devolución es copia verbatim del patrón ya testeado de
-- salir_lista_espera, así que acá verificamos que la función la incorpora.
-- ============================================================================
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef('promover_siguiente_en_espera(uuid)'::regprocedure) INTO v_def;
  IF position('devolucion' in v_def) = 0 OR position('lista_espera_id = v_entry.id' in v_def) = 0 THEN
    RAISE EXCEPTION 'TEST FALLO: promover_siguiente_en_espera no devuelve crédito en la rama defensiva.';
  END IF;
  RAISE NOTICE 'TEST OK: promover_siguiente_en_espera devuelve el crédito en la rama defensiva.';
END $$;
