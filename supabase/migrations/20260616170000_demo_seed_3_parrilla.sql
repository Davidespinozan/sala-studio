-- ============================================================================
-- DEMO HEALTHYSPACE · Lote 3 — parrilla de horarios recurrentes
-- ----------------------------------------------------------------------------
-- Define la grilla semanal del demo: 12 horarios recurrentes sobre las 3 salas
-- reales (Barre, Cycling, Pilates) con los 4 instructores, mañana y tarde,
-- de lunes a sábado. El modelo virtual de clases las expande solas → la agenda
-- del admin y la vista "Reservar" del socio se ven llenas sin materializar nada.
--
-- dias_semana: 0=domingo .. 6=sábado. cupo_max NULL → hereda recursos.cupo_max_default.
-- Idempotente: borra los horarios previos del tenant (incluido el de prueba) y
-- reinserta la parrilla completa.
-- ============================================================================

DELETE FROM horarios_recurrentes
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'healthyspace');

INSERT INTO horarios_recurrentes
  (tenant_id, recurso_id, dias_semana, hora_inicio, duracion_minutos, nombre, instructor_id)
SELECT t.id, v.recurso_id, v.dias, v.hora, v.dur, v.nombre, v.instructor_id
FROM tenants t,
(VALUES
  -- ── Barre (962c9992) ──────────────────────────────────────────────────────
  ('962c9992-7da8-4dc2-a238-dde34a4edd1f'::uuid, ARRAY[1,3,5], '07:00'::time, 45, 'Barre Express', '27491ab6-38fa-421b-ada4-6e73137431fc'::uuid),
  ('962c9992-7da8-4dc2-a238-dde34a4edd1f'::uuid, ARRAY[2,4],   '09:00'::time, 60, 'Barre Tonic',   '27491ab6-38fa-421b-ada4-6e73137431fc'::uuid),
  ('962c9992-7da8-4dc2-a238-dde34a4edd1f'::uuid, ARRAY[1,3,5], '18:00'::time, 60, 'Barre Flow',    'ea88fbbd-cd62-45ec-a1ba-4d37d5c5b145'::uuid),
  ('962c9992-7da8-4dc2-a238-dde34a4edd1f'::uuid, ARRAY[6],     '10:00'::time, 60, 'Barre Sculpt',  'ea88fbbd-cd62-45ec-a1ba-4d37d5c5b145'::uuid),
  -- ── Cycling (bb18818b) ────────────────────────────────────────────────────
  ('bb18818b-c597-4951-b37a-0b0f63aa373b'::uuid, ARRAY[1,2,3,4,5], '06:30'::time, 45, 'Ride AM',       'e9f537c7-bcba-4b48-bc87-b3414ed4f3a2'::uuid),
  ('bb18818b-c597-4951-b37a-0b0f63aa373b'::uuid, ARRAY[1,3,5],     '19:00'::time, 45, 'Power Ride',    'c825b4df-4f1f-4d7f-a1d8-6e08784e28f5'::uuid),
  ('bb18818b-c597-4951-b37a-0b0f63aa373b'::uuid, ARRAY[2,4],       '18:00'::time, 60, 'Endurance',     'e9f537c7-bcba-4b48-bc87-b3414ed4f3a2'::uuid),
  ('bb18818b-c597-4951-b37a-0b0f63aa373b'::uuid, ARRAY[6],         '09:00'::time, 45, 'Saturday Ride', 'c825b4df-4f1f-4d7f-a1d8-6e08784e28f5'::uuid),
  -- ── Pilates (692d996e) ────────────────────────────────────────────────────
  ('692d996e-f587-4ad4-8b89-e6cf6e4a21b6'::uuid, ARRAY[1,3,5],   '08:00'::time, 60, 'Pilates Mat',         'ea88fbbd-cd62-45ec-a1ba-4d37d5c5b145'::uuid),
  ('692d996e-f587-4ad4-8b89-e6cf6e4a21b6'::uuid, ARRAY[2,4],     '07:00'::time, 50, 'Reformer Flow',       '27491ab6-38fa-421b-ada4-6e73137431fc'::uuid),
  ('692d996e-f587-4ad4-8b89-e6cf6e4a21b6'::uuid, ARRAY[1,2,3,4], '19:00'::time, 60, 'Pilates PM',          'ea88fbbd-cd62-45ec-a1ba-4d37d5c5b145'::uuid),
  ('692d996e-f587-4ad4-8b89-e6cf6e4a21b6'::uuid, ARRAY[6],       '11:00'::time, 60, 'Pilates Restorativo', '27491ab6-38fa-421b-ada4-6e73137431fc'::uuid)
) AS v(recurso_id, dias, hora, dur, nombre, instructor_id)
WHERE t.slug = 'healthyspace';
