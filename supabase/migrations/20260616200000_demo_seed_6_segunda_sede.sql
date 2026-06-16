-- ============================================================================
-- DEMO HEALTHYSPACE · Lote 6 — poblar la segunda sede (Sucursal Culiacán)
-- ----------------------------------------------------------------------------
-- "Sucursal Culiacán" (5235387a) estaba vacía → si un visitante del demo caía en
-- ella (o quedaba seleccionada en localStorage) veía el admin sin salas. Le damos
-- su propio set: 3 salas, 4 instructores y una parrilla de 12 horarios. Así el
-- multi-sede luce en reportes y ninguna sede queda vacía.
--
-- DESPUÉS de este lote hay que RE-CORRER el Lote 5 (reservas): es idempotente y
-- reconstruye clases+reservas a partir de TODOS los horarios (ambas sedes).
--
-- Idempotente: limpia lo que haya en Culiacán (en orden por FKs) y reinserta.
-- ============================================================================

-- ── Limpieza del scope Culiacán (FK-safe) ───────────────────────────────────
DELETE FROM reservas WHERE clase_id IN (SELECT id FROM clases WHERE sucursal_id = '5235387a-1196-48b2-8c2e-2a9c04a6d674');
DELETE FROM clases              WHERE sucursal_id = '5235387a-1196-48b2-8c2e-2a9c04a6d674';
DELETE FROM horarios_recurrentes WHERE sucursal_id = '5235387a-1196-48b2-8c2e-2a9c04a6d674';
DELETE FROM recursos            WHERE sucursal_id = '5235387a-1196-48b2-8c2e-2a9c04a6d674';
DELETE FROM instructores        WHERE sucursal_id = '5235387a-1196-48b2-8c2e-2a9c04a6d674';

-- ── 1) Salas de Culiacán ────────────────────────────────────────────────────
INSERT INTO recursos (tenant_id, sucursal_id, slug, nombre, tipo, cupos, cupo_max_default, activo, orden)
SELECT t.id, '5235387a-1196-48b2-8c2e-2a9c04a6d674'::uuid, v.slug, v.nombre, 'sala_grupal', v.cupo, v.cupo, true, v.orden
FROM (SELECT id FROM tenants WHERE slug = 'healthyspace') t,
(VALUES
  ('barre-clc',   'Barre',   15, 1),
  ('cycling-clc', 'Cycling', 12, 2),
  ('pilates-clc', 'Pilates', 12, 3)
) AS v(slug, nombre, cupo, orden);

-- ── 2) Instructores de Culiacán ─────────────────────────────────────────────
INSERT INTO instructores (tenant_id, sucursal_id, nombre, activo, orden)
SELECT t.id, '5235387a-1196-48b2-8c2e-2a9c04a6d674'::uuid, v.nombre, true, v.orden
FROM (SELECT id FROM tenants WHERE slug = 'healthyspace') t,
(VALUES
  ('Lucía Bravo', 1),
  ('Tomás Reyes', 2),
  ('Carla Núñez', 3),
  ('Bruno Vidal', 4)
) AS v(nombre, orden);

-- ── 3) Parrilla de Culiacán (12 horarios) ───────────────────────────────────
-- Referencia las salas por slug y los instructores por nombre (ambos recién
-- creados en esta sede).
INSERT INTO horarios_recurrentes
  (tenant_id, sucursal_id, recurso_id, dias_semana, hora_inicio, duracion_minutos, nombre, instructor_id)
SELECT t.id, '5235387a-1196-48b2-8c2e-2a9c04a6d674'::uuid, r.id, v.dias, v.hora, v.dur, v.nombre, i.id
FROM (SELECT id FROM tenants WHERE slug = 'healthyspace') t
CROSS JOIN (VALUES
  -- Barre
  ('barre-clc',   ARRAY[1,3,5], '08:00'::time, 45, 'Barre Express',       'Lucía Bravo'),
  ('barre-clc',   ARRAY[2,4],   '10:00'::time, 60, 'Barre Tonic',         'Carla Núñez'),
  ('barre-clc',   ARRAY[1,3,5], '19:00'::time, 60, 'Barre Flow',          'Lucía Bravo'),
  ('barre-clc',   ARRAY[6],     '11:00'::time, 60, 'Barre Sculpt',        'Carla Núñez'),
  -- Cycling
  ('cycling-clc', ARRAY[1,2,3,4,5], '07:00'::time, 45, 'Ride AM',         'Tomás Reyes'),
  ('cycling-clc', ARRAY[1,3,5],     '20:00'::time, 45, 'Power Ride',      'Bruno Vidal'),
  ('cycling-clc', ARRAY[2,4],       '19:00'::time, 60, 'Endurance',       'Tomás Reyes'),
  ('cycling-clc', ARRAY[6],         '10:00'::time, 45, 'Saturday Ride',   'Bruno Vidal'),
  -- Pilates
  ('pilates-clc', ARRAY[1,3,5],   '09:00'::time, 60, 'Pilates Mat',         'Carla Núñez'),
  ('pilates-clc', ARRAY[2,4],     '08:00'::time, 50, 'Reformer Flow',       'Lucía Bravo'),
  ('pilates-clc', ARRAY[1,2,3,4], '20:00'::time, 60, 'Pilates PM',          'Carla Núñez'),
  ('pilates-clc', ARRAY[6],       '12:00'::time, 60, 'Pilates Restorativo', 'Lucía Bravo')
) AS v(rslug, dias, hora, dur, nombre, iname)
JOIN recursos     r ON r.tenant_id = t.id AND r.slug = v.rslug AND r.sucursal_id = '5235387a-1196-48b2-8c2e-2a9c04a6d674'::uuid
JOIN instructores i ON i.tenant_id = t.id AND i.nombre = v.iname AND i.sucursal_id = '5235387a-1196-48b2-8c2e-2a9c04a6d674'::uuid;
