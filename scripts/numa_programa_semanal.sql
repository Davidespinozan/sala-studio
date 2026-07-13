-- ============================================================================
-- NUMA — cargar el programa semanal real y retirar los horarios viejos.
-- ----------------------------------------------------------------------------
-- Requiere la migración 20260714110000 (enfoque/disciplina/foto por clase).
--
-- Programa (una sola sala, una clase distinta por día):
--   LUN y JUE   PWR + METCon      · Tren inferior + CardioHiit
--   MAR y VIE   FORCE + METCon    · Tren superior + CardioHiit
--   MIÉ         FULL BODY         · Cuerpo completo
--   SÁB         FUERZA + CardioHiit
--
-- Horas:  L–V  5, 6, 7, 8, 9 am  y  4, 5, 6, 7, 8 pm   (cupo 15)
--         SÁB  6, 7, 8, 9 am                            (cupo 20)
--   → 10 franjas × (L/J, M/V, MIÉ) + 4 del sábado = 34 horarios.
--   Duración: 60 min (las franjas son cada hora).
--
-- Los 2 horarios viejos ("Sala Numa", L–V, 5am y 6am) NO se borran a ciegas:
-- si alguna de sus clases tiene reservas, borrarlos arrastraría esas clases y
-- las reservas de los socios (FK en cascada). Se BORRAN solo si están limpios;
-- si tienen reservas, se DESACTIVAN (dejan de generar clases, el pasado queda
-- intacto). El script informa qué hizo con cada uno.
--
-- Es idempotente: si lo corrés dos veces, no duplica (borra los que él mismo
-- creó antes de insertar).
-- ============================================================================

DO $$
DECLARE
  v_tenant   uuid;
  v_sucursal uuid;
  v_recurso  uuid;
  v_borrados int := 0;
  v_desactivados int := 0;
  h record;
  v_tiene_reservas boolean;

  -- Franjas horarias
  v_horas_semana time[] := ARRAY['05:00','06:00','07:00','08:00','09:00',
                                 '16:00','17:00','18:00','19:00','20:00']::time[];
  v_horas_sabado time[] := ARRAY['06:00','07:00','08:00','09:00']::time[];
  v_hora time;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'numawellness';
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No existe el tenant numawellness';
  END IF;

  SELECT id INTO v_sucursal FROM sucursales
  WHERE tenant_id = v_tenant AND activa ORDER BY orden LIMIT 1;

  SELECT id INTO v_recurso FROM recursos
  WHERE tenant_id = v_tenant AND activo ORDER BY orden LIMIT 1;

  IF v_sucursal IS NULL OR v_recurso IS NULL THEN
    RAISE EXCEPTION 'Numa no tiene sucursal o sala activa';
  END IF;

  -- ── 1) Limpiar lo que este mismo script haya creado antes (idempotencia) ──
  DELETE FROM horarios_recurrentes
  WHERE tenant_id = v_tenant
    AND nombre IN ('PWR + METCon', 'FORCE + METCon', 'FULL BODY', 'FUERZA + CardioHiit')
    AND NOT EXISTS (
      SELECT 1 FROM clases c
      JOIN reservas r ON r.clase_id = c.id
      WHERE c.horario_recurrente_id = horarios_recurrentes.id
        AND r.status IN ('confirmada', 'completada')
    );

  -- ── 2) Retirar los horarios VIEJOS (todo lo que no sea del programa nuevo) ─
  FOR h IN
    SELECT id, nombre, hora_inicio
    FROM horarios_recurrentes
    WHERE tenant_id = v_tenant
      AND nombre NOT IN ('PWR + METCon', 'FORCE + METCon', 'FULL BODY', 'FUERZA + CardioHiit')
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM clases c
      JOIN reservas r ON r.clase_id = c.id
      WHERE c.horario_recurrente_id = h.id
        AND r.status IN ('confirmada', 'completada')
    ) INTO v_tiene_reservas;

    IF v_tiene_reservas THEN
      -- Tiene socios adentro: no se toca el pasado, solo deja de generar futuro.
      UPDATE horarios_recurrentes SET activo = false WHERE id = h.id;
      v_desactivados := v_desactivados + 1;
      RAISE NOTICE 'DESACTIVADO (tiene reservas): % %', h.nombre, h.hora_inicio;
    ELSE
      DELETE FROM horarios_recurrentes WHERE id = h.id;
      v_borrados := v_borrados + 1;
      RAISE NOTICE 'BORRADO (sin reservas): % %', h.nombre, h.hora_inicio;
    END IF;
  END LOOP;

  -- ── 3) Cargar el programa ─────────────────────────────────────────────────
  -- Lunes (1) y Jueves (4)
  FOREACH v_hora IN ARRAY v_horas_semana LOOP
    INSERT INTO horarios_recurrentes
      (tenant_id, sucursal_id, recurso_id, dias_semana, hora_inicio, duracion_minutos,
       nombre, descripcion, disciplina, cupo_max, activo)
    VALUES
      (v_tenant, v_sucursal, v_recurso, ARRAY[1, 4], v_hora, 60,
       'PWR + METCon', 'Tren inferior + CardioHiit', 'Fuerza', 15, true);
  END LOOP;

  -- Martes (2) y Viernes (5)
  FOREACH v_hora IN ARRAY v_horas_semana LOOP
    INSERT INTO horarios_recurrentes
      (tenant_id, sucursal_id, recurso_id, dias_semana, hora_inicio, duracion_minutos,
       nombre, descripcion, disciplina, cupo_max, activo)
    VALUES
      (v_tenant, v_sucursal, v_recurso, ARRAY[2, 5], v_hora, 60,
       'FORCE + METCon', 'Tren superior + CardioHiit', 'Fuerza', 15, true);
  END LOOP;

  -- Miércoles (3)
  FOREACH v_hora IN ARRAY v_horas_semana LOOP
    INSERT INTO horarios_recurrentes
      (tenant_id, sucursal_id, recurso_id, dias_semana, hora_inicio, duracion_minutos,
       nombre, descripcion, disciplina, cupo_max, activo)
    VALUES
      (v_tenant, v_sucursal, v_recurso, ARRAY[3], v_hora, 60,
       'FULL BODY', 'Cuerpo completo', 'Fuerza', 15, true);
  END LOOP;

  -- Sábado (6) — cupo 20
  FOREACH v_hora IN ARRAY v_horas_sabado LOOP
    INSERT INTO horarios_recurrentes
      (tenant_id, sucursal_id, recurso_id, dias_semana, hora_inicio, duracion_minutos,
       nombre, descripcion, disciplina, cupo_max, activo)
    VALUES
      (v_tenant, v_sucursal, v_recurso, ARRAY[6], v_hora, 60,
       'FUERZA + CardioHiit', 'Fuerza + CardioHiit', 'Fuerza', 20, true);
  END LOOP;

  RAISE NOTICE 'Viejos borrados: % · desactivados: %', v_borrados, v_desactivados;
END $$;

-- ============================================================================
-- RESULTADO — el programa como quedó cargado.
-- ============================================================================
SELECT
  CASE
    WHEN h.dias_semana = ARRAY[1, 4] THEN 'LUN y JUE'
    WHEN h.dias_semana = ARRAY[2, 5] THEN 'MAR y VIE'
    WHEN h.dias_semana = ARRAY[3]    THEN 'MIÉ'
    WHEN h.dias_semana = ARRAY[6]    THEN 'SÁB'
    ELSE h.dias_semana::text
  END                              AS dias,
  h.nombre                         AS clase,
  h.descripcion                    AS enfoque,
  count(*)                         AS franjas,
  min(h.hora_inicio)::text         AS desde,
  max(h.hora_inicio)::text         AS hasta,
  max(h.cupo_max)                  AS cupo,
  bool_and(h.activo)               AS activo
FROM horarios_recurrentes h
JOIN tenants t ON t.id = h.tenant_id AND t.slug = 'numawellness'
GROUP BY dias, h.nombre, h.descripcion
ORDER BY min(h.dias_semana[1]), min(h.hora_inicio);
