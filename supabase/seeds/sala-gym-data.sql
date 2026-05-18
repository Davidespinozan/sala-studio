-- =============================================================================
-- SALA Studio — Seed gym realista (S2.5)
-- =============================================================================
-- Reemplaza los recursos heredados de EKKO (Estudio 1, Estudio 2, Black) por
-- 3 salas de gym realistas. Refresca tiers, crea 8 mock members y siembra
-- reservas distribuidas en 7 días.
--
-- Workflow:
--   1. Pegá este archivo en Supabase SQL Editor (project omrlbvhbggnrwwzlgxji).
--   2. Click Run.
--   3. Confirmá "Success".
--
-- Idempotente: se puede correr N veces sin duplicar datos.
--
-- Notas técnicas:
--   - CUPO_MAX_MOCK en claseAdapter.ts vale 8 (matching con 8 mocks).
--   - Reservas seed usan prefijo de folio 'SAL-DEMO-' para identificarlas.
--   - Si re-corrés el seed, las reservas mock se borran y recrean.
-- =============================================================================

SET TIME ZONE 'America/Mexico_City';

-- =============================================================================
-- 1. Pre-flight check
-- =============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE slug = 'sala-demo') THEN
    RAISE EXCEPTION 'Tenant sala-demo no existe. Corré supabase/seeds/sala-demo.sql primero.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM usuarios u
    JOIN tenants t ON t.id = u.tenant_id
    WHERE t.slug = 'sala-demo' AND u.rol = 'admin'
  ) THEN
    RAISE EXCEPTION 'No hay admin en sala-demo. Corré supabase/seeds/admin.sql primero.';
  END IF;
END $$;

-- =============================================================================
-- 2. Cleanup selectivo de datos EKKO heredados
-- =============================================================================

-- 2a. Notificaciones de reservas viejas (filtradas por metadata.recurso_nombre)
DELETE FROM notificaciones
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'sala-demo')
  AND (
    metadata->>'recurso_nombre' IN ('Estudio 1', 'Estudio 2', 'Black')
    OR metadata->>'reserva_id' IN (
      SELECT id::text FROM reservas
      WHERE recurso_id IN (
        SELECT id FROM recursos
        WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'sala-demo')
          AND slug IN ('estudio-1', 'estudio-2', 'black')
      )
    )
  );

-- 2b. Reservas de recursos EKKO
DELETE FROM reservas
WHERE recurso_id IN (
  SELECT id FROM recursos
  WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'sala-demo')
    AND slug IN ('estudio-1', 'estudio-2', 'black')
);

-- 2c. Recursos EKKO
DELETE FROM recursos
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'sala-demo')
  AND slug IN ('estudio-1', 'estudio-2', 'black');

-- =============================================================================
-- 3. UPDATE tiers — refresh copy gym (mantiene slugs basica/pro)
-- =============================================================================

UPDATE tiers SET
  nombre = 'Drop-In',
  descripcion = '1 clase suelta. Pagás solo cuando venís. Ideal para probar antes de comprometerte.',
  precio_centavos = 20000,
  beneficios = '[
    "1 clase a tu elección",
    "Vence en 30 días desde la compra",
    "Sin compromiso mensual",
    "Acceso a cualquier sala"
  ]'::jsonb,
  reglas = jsonb_build_object(
    'max_invitados', 0,
    'tipo', 'pase_suelto'
  )
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'sala-demo')
  AND slug = 'basica';

UPDATE tiers SET
  nombre = 'Ilimitado Mensual',
  descripcion = 'Clases ilimitadas todos los días. La forma más simple de entrenar consistente.',
  precio_centavos = 220000,
  beneficios = '[
    "Clases ilimitadas todos los días",
    "Acceso a todas las salas (Yoga / Spinning / Funcional)",
    "Hasta 4 invitados por clase",
    "Reserva con 30 días de anticipación",
    "Sin penalidad si cancelás con tiempo"
  ]'::jsonb,
  reglas = jsonb_build_object(
    'max_invitados', 4,
    'tipo', 'ilimitado'
  )
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'sala-demo')
  AND slug = 'pro';

-- =============================================================================
-- 4. INSERT/UPSERT 3 recursos gym
-- =============================================================================

INSERT INTO recursos (
  tenant_id, slug, nombre, descripcion, tipo, cupos, horarios,
  tiers_permitidos, equipo_incluido, tipo_contenido, capacidad_personas,
  activo, orden
) VALUES
(
  (SELECT id FROM tenants WHERE slug = 'sala-demo'),
  'sala-yoga',
  'Sala Yoga',
  'Espacio cálido con piso de madera, espejos amplios y sistema de sonido. Ideal para clases de movimiento consciente y trabajo de cuerpo.',
  'sala_grupal',
  20,
  '[
    {"dia":"lunes","inicio":"07:00","fin":"09:00"},
    {"dia":"lunes","inicio":"18:00","fin":"21:00"},
    {"dia":"martes","inicio":"07:00","fin":"09:00"},
    {"dia":"martes","inicio":"18:00","fin":"21:00"},
    {"dia":"miercoles","inicio":"07:00","fin":"09:00"},
    {"dia":"miercoles","inicio":"18:00","fin":"21:00"},
    {"dia":"jueves","inicio":"07:00","fin":"09:00"},
    {"dia":"jueves","inicio":"18:00","fin":"21:00"},
    {"dia":"viernes","inicio":"07:00","fin":"09:00"},
    {"dia":"viernes","inicio":"18:00","fin":"21:00"},
    {"dia":"sabado","inicio":"08:00","fin":"12:00"},
    {"dia":"domingo","inicio":"09:00","fin":"11:00"}
  ]'::jsonb,
  ARRAY['basica','pro'],
  ARRAY['Colchonetas','Bloques','Cintas','Bolsters'],
  ARRAY['Yoga','Pilates','Stretching'],
  20, true, 1
),
(
  (SELECT id FROM tenants WHERE slug = 'sala-demo'),
  'sala-spinning',
  'Sala Spinning',
  '20 bicicletas profesionales, sistema de luces sincronizado y audio inmersivo. Energía pura para clases de cycling indoor.',
  'sala_grupal',
  25,
  '[
    {"dia":"lunes","inicio":"06:00","fin":"09:00"},
    {"dia":"lunes","inicio":"17:00","fin":"21:00"},
    {"dia":"martes","inicio":"06:00","fin":"09:00"},
    {"dia":"martes","inicio":"17:00","fin":"21:00"},
    {"dia":"miercoles","inicio":"06:00","fin":"09:00"},
    {"dia":"miercoles","inicio":"17:00","fin":"21:00"},
    {"dia":"jueves","inicio":"06:00","fin":"09:00"},
    {"dia":"jueves","inicio":"17:00","fin":"21:00"},
    {"dia":"viernes","inicio":"06:00","fin":"09:00"},
    {"dia":"viernes","inicio":"17:00","fin":"21:00"},
    {"dia":"sabado","inicio":"08:00","fin":"11:00"}
  ]'::jsonb,
  ARRAY['basica','pro'],
  ARRAY['Bicicletas','Toallas','Botellas de agua'],
  ARRAY['Spinning','Cycling'],
  25, true, 2
),
(
  (SELECT id FROM tenants WHERE slug = 'sala-demo'),
  'sala-funcional',
  'Sala Funcional',
  'Área amplia con rigs de crossfit, kettlebells, cuerdas y espacio para movimientos compuestos. Para entrenamientos de fuerza y resistencia.',
  'sala_grupal',
  15,
  '[
    {"dia":"lunes","inicio":"06:00","fin":"09:00"},
    {"dia":"lunes","inicio":"17:00","fin":"22:00"},
    {"dia":"martes","inicio":"06:00","fin":"09:00"},
    {"dia":"martes","inicio":"17:00","fin":"22:00"},
    {"dia":"miercoles","inicio":"06:00","fin":"09:00"},
    {"dia":"miercoles","inicio":"17:00","fin":"22:00"},
    {"dia":"jueves","inicio":"06:00","fin":"09:00"},
    {"dia":"jueves","inicio":"17:00","fin":"22:00"},
    {"dia":"viernes","inicio":"06:00","fin":"09:00"},
    {"dia":"viernes","inicio":"17:00","fin":"22:00"},
    {"dia":"sabado","inicio":"08:00","fin":"13:00"}
  ]'::jsonb,
  ARRAY['basica','pro'],
  ARRAY['Mancuernas','Kettlebells','Cajones pliométricos','Cuerdas para saltar'],
  ARRAY['Crossfit','HIIT','Funcional'],
  15, true, 3
)
ON CONFLICT (tenant_id, slug) DO UPDATE SET
  nombre = EXCLUDED.nombre,
  descripcion = EXCLUDED.descripcion,
  tipo = EXCLUDED.tipo,
  cupos = EXCLUDED.cupos,
  horarios = EXCLUDED.horarios,
  tiers_permitidos = EXCLUDED.tiers_permitidos,
  equipo_incluido = EXCLUDED.equipo_incluido,
  tipo_contenido = EXCLUDED.tipo_contenido,
  capacidad_personas = EXCLUDED.capacidad_personas,
  activo = EXCLUDED.activo,
  orden = EXCLUDED.orden;

-- =============================================================================
-- 5. INSERT 8 mock usuarios (idempotente)
-- =============================================================================

INSERT INTO usuarios (
  tenant_id, auth_id, email, nombre, telefono, rol, status,
  membresia_tier, invitado
) VALUES
  ((SELECT id FROM tenants WHERE slug='sala-demo'), NULL,
   'maria.garcia@example.com',    'María García',    '+52 1 555-101-1001', 'miembro', 'activo', 'pro',    true),
  ((SELECT id FROM tenants WHERE slug='sala-demo'), NULL,
   'carlos.mendoza@example.com',  'Carlos Mendoza',  '+52 1 555-102-1002', 'miembro', 'activo', 'pro',    true),
  ((SELECT id FROM tenants WHERE slug='sala-demo'), NULL,
   'sofia.ramirez@example.com',   'Sofía Ramírez',   '+52 1 555-103-1003', 'miembro', 'activo', 'pro',    true),
  ((SELECT id FROM tenants WHERE slug='sala-demo'), NULL,
   'diego.hernandez@example.com', 'Diego Hernández', '+52 1 555-104-1004', 'miembro', 'activo', 'basica', true),
  ((SELECT id FROM tenants WHERE slug='sala-demo'), NULL,
   'lucia.torres@example.com',    'Lucía Torres',    '+52 1 555-105-1005', 'miembro', 'activo', 'pro',    true),
  ((SELECT id FROM tenants WHERE slug='sala-demo'), NULL,
   'pablo.castro@example.com',    'Pablo Castro',    '+52 1 555-106-1006', 'miembro', 'activo', 'pro',    true),
  ((SELECT id FROM tenants WHERE slug='sala-demo'), NULL,
   'andrea.lopez@example.com',    'Andrea López',    '+52 1 555-107-1007', 'miembro', 'activo', 'pro',    true),
  ((SELECT id FROM tenants WHERE slug='sala-demo'), NULL,
   'roberto.vega@example.com',    'Roberto Vega',    '+52 1 555-108-1008', 'miembro', 'activo', 'basica', true)
ON CONFLICT (tenant_id, email) DO UPDATE SET
  nombre = EXCLUDED.nombre,
  telefono = EXCLUDED.telefono,
  membresia_tier = EXCLUDED.membresia_tier,
  status = EXCLUDED.status,
  invitado = EXCLUDED.invitado;

-- =============================================================================
-- 6. INSERT membresias activas para los 8 mocks (idempotente: delete+insert)
-- =============================================================================

-- Limpiar membresias previas de los mocks (preserva otros usuarios)
DELETE FROM membresias
WHERE usuario_id IN (
  SELECT id FROM usuarios
  WHERE tenant_id = (SELECT id FROM tenants WHERE slug='sala-demo')
    AND email LIKE '%@example.com'
);

-- Insertar membresias nuevas
INSERT INTO membresias (
  tenant_id, usuario_id, tier_id, status,
  periodo_actual_inicio, periodo_actual_fin, commitment_ends_at
)
SELECT
  u.tenant_id,
  u.id,
  t.id,
  'activa',
  now() - interval '5 days',
  now() + interval '25 days',
  now() + interval '6 months'
FROM usuarios u
JOIN tiers t ON t.tenant_id = u.tenant_id AND t.slug = u.membresia_tier
WHERE u.tenant_id = (SELECT id FROM tenants WHERE slug='sala-demo')
  AND u.email LIKE '%@example.com';

-- Vincular usuario.membresia_activa_id + commitment_ends_at
UPDATE usuarios u
SET membresia_activa_id = m.id,
    commitment_ends_at = m.commitment_ends_at
FROM membresias m
WHERE m.usuario_id = u.id
  AND m.status = 'activa'
  AND u.email LIKE '%@example.com';

-- =============================================================================
-- 7. INSERT reservas con folio 'SAL-DEMO-XXXX' (idempotente: delete+insert)
-- =============================================================================

DELETE FROM reservas WHERE folio LIKE 'SAL-DEMO-%';

DO $$
DECLARE
  v_tenant_id    uuid;
  v_yoga_id      uuid;
  v_spinning_id  uuid;
  v_funcional_id uuid;
  v_admin_id     uuid;
  v_mock_ids     uuid[];
  v_today        timestamptz;
  v_n            integer := 1;
  v_slot         timestamptz;
  i              integer;
  idx            integer;
BEGIN
  -- Fetch IDs
  SELECT id INTO v_tenant_id    FROM tenants  WHERE slug='sala-demo';
  SELECT id INTO v_yoga_id      FROM recursos WHERE tenant_id=v_tenant_id AND slug='sala-yoga';
  SELECT id INTO v_spinning_id  FROM recursos WHERE tenant_id=v_tenant_id AND slug='sala-spinning';
  SELECT id INTO v_funcional_id FROM recursos WHERE tenant_id=v_tenant_id AND slug='sala-funcional';
  SELECT id INTO v_admin_id     FROM usuarios WHERE tenant_id=v_tenant_id AND rol='admin' LIMIT 1;

  SELECT array_agg(id ORDER BY email) INTO v_mock_ids
  FROM usuarios
  WHERE tenant_id = v_tenant_id
    AND email LIKE '%@example.com';

  v_today := date_trunc('day', now());

  IF array_length(v_mock_ids, 1) <> 8 THEN
    RAISE EXCEPTION 'Esperaba 8 mocks (.@example.com), encontré %', array_length(v_mock_ids, 1);
  END IF;

  -- ---------------------------------------------------------------------------
  -- ESCENARIO 1: Admin T+1 8:00 Yoga (hero "Próxima clase" del admin)
  -- ---------------------------------------------------------------------------
  v_slot := v_today + interval '1 day' + interval '8 hours';
  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                        duracion_min, folio, status, invitados_count)
  VALUES (v_tenant_id, v_yoga_id, v_admin_id, v_slot, v_slot + interval '1 hour',
          60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
  v_n := v_n + 1;

  -- ---------------------------------------------------------------------------
  -- ESCENARIO 2: LLENA — T+1 7:00 Yoga (8 mocks → 8/8 → "Lista de espera")
  -- ---------------------------------------------------------------------------
  v_slot := v_today + interval '1 day' + interval '7 hours';
  FOR i IN 1..8 LOOP
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                          duracion_min, folio, status, invitados_count)
    VALUES (v_tenant_id, v_yoga_id, v_mock_ids[i], v_slot, v_slot + interval '1 hour',
            60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
    v_n := v_n + 1;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- ESCENARIO 3: CORAL — Hoy 19:00 Spinning (6 mocks → 6/8 → ≤3 libres)
  -- ---------------------------------------------------------------------------
  v_slot := v_today + interval '19 hours';
  FOR i IN 1..6 LOOP
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                          duracion_min, folio, status, invitados_count)
    VALUES (v_tenant_id, v_spinning_id, v_mock_ids[i], v_slot, v_slot + interval '1 hour',
            60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
    v_n := v_n + 1;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- ESCENARIO 4: NORMAL — Hoy 18:00 Funcional (4 mocks → 4/8 saludable)
  -- ---------------------------------------------------------------------------
  v_slot := v_today + interval '18 hours';
  FOR i IN 1..4 LOOP
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                          duracion_min, folio, status, invitados_count)
    VALUES (v_tenant_id, v_funcional_id, v_mock_ids[i], v_slot, v_slot + interval '1 hour',
            60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
    v_n := v_n + 1;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- DISTRIBUCIÓN ADICIONAL: T+2..T+5 ocupaciones variadas
  -- ---------------------------------------------------------------------------

  -- T+2 7:00 Yoga — 3 mocks (1,3,5) — normal
  v_slot := v_today + interval '2 days' + interval '7 hours';
  FOREACH idx IN ARRAY ARRAY[1,3,5] LOOP
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                          duracion_min, folio, status, invitados_count)
    VALUES (v_tenant_id, v_yoga_id, v_mock_ids[idx], v_slot, v_slot + interval '1 hour',
            60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
    v_n := v_n + 1;
  END LOOP;

  -- T+2 18:00 Spinning — 7 mocks (1..7) — coral con 1 libre
  v_slot := v_today + interval '2 days' + interval '18 hours';
  FOR i IN 1..7 LOOP
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                          duracion_min, folio, status, invitados_count)
    VALUES (v_tenant_id, v_spinning_id, v_mock_ids[i], v_slot, v_slot + interval '1 hour',
            60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
    v_n := v_n + 1;
  END LOOP;

  -- T+2 19:00 Funcional — 2 mocks (4,8) — sparse
  v_slot := v_today + interval '2 days' + interval '19 hours';
  FOREACH idx IN ARRAY ARRAY[4,8] LOOP
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                          duracion_min, folio, status, invitados_count)
    VALUES (v_tenant_id, v_funcional_id, v_mock_ids[idx], v_slot, v_slot + interval '1 hour',
            60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
    v_n := v_n + 1;
  END LOOP;

  -- T+3 7:00 Yoga — 5 mocks (1,2,3,5,7) — normal alto
  v_slot := v_today + interval '3 days' + interval '7 hours';
  FOREACH idx IN ARRAY ARRAY[1,2,3,5,7] LOOP
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                          duracion_min, folio, status, invitados_count)
    VALUES (v_tenant_id, v_yoga_id, v_mock_ids[idx], v_slot, v_slot + interval '1 hour',
            60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
    v_n := v_n + 1;
  END LOOP;

  -- T+3 18:00 Spinning — 4 mocks (2,4,6,8) — normal
  v_slot := v_today + interval '3 days' + interval '18 hours';
  FOREACH idx IN ARRAY ARRAY[2,4,6,8] LOOP
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                          duracion_min, folio, status, invitados_count)
    VALUES (v_tenant_id, v_spinning_id, v_mock_ids[idx], v_slot, v_slot + interval '1 hour',
            60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
    v_n := v_n + 1;
  END LOOP;

  -- T+3 19:00 Funcional — 6 mocks (1,2,3,4,5,8) — coral 2 libres
  v_slot := v_today + interval '3 days' + interval '19 hours';
  FOREACH idx IN ARRAY ARRAY[1,2,3,4,5,8] LOOP
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                          duracion_min, folio, status, invitados_count)
    VALUES (v_tenant_id, v_funcional_id, v_mock_ids[idx], v_slot, v_slot + interval '1 hour',
            60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
    v_n := v_n + 1;
  END LOOP;

  -- T+4 7:00 Spinning — 3 mocks (3,5,7) — normal bajo
  v_slot := v_today + interval '4 days' + interval '7 hours';
  FOREACH idx IN ARRAY ARRAY[3,5,7] LOOP
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                          duracion_min, folio, status, invitados_count)
    VALUES (v_tenant_id, v_spinning_id, v_mock_ids[idx], v_slot, v_slot + interval '1 hour',
            60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
    v_n := v_n + 1;
  END LOOP;

  -- T+4 18:00 Yoga — 2 mocks (1,8) — sparse
  v_slot := v_today + interval '4 days' + interval '18 hours';
  FOREACH idx IN ARRAY ARRAY[1,8] LOOP
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                          duracion_min, folio, status, invitados_count)
    VALUES (v_tenant_id, v_yoga_id, v_mock_ids[idx], v_slot, v_slot + interval '1 hour',
            60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
    v_n := v_n + 1;
  END LOOP;

  -- T+4 19:00 Funcional — 1 mock (4) — muy sparse
  v_slot := v_today + interval '4 days' + interval '19 hours';
  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                        duracion_min, folio, status, invitados_count)
  VALUES (v_tenant_id, v_funcional_id, v_mock_ids[4], v_slot, v_slot + interval '1 hour',
          60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
  v_n := v_n + 1;

  -- T+5 (sábado) 8:00 Yoga — 4 mocks (1,2,3,6) — normal
  v_slot := v_today + interval '5 days' + interval '8 hours';
  FOREACH idx IN ARRAY ARRAY[1,2,3,6] LOOP
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                          duracion_min, folio, status, invitados_count)
    VALUES (v_tenant_id, v_yoga_id, v_mock_ids[idx], v_slot, v_slot + interval '1 hour',
            60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
    v_n := v_n + 1;
  END LOOP;

  -- T+5 (sábado) 9:00 Spinning — 2 mocks (5,7) — sparse
  v_slot := v_today + interval '5 days' + interval '9 hours';
  FOREACH idx IN ARRAY ARRAY[5,7] LOOP
    INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                          duracion_min, folio, status, invitados_count)
    VALUES (v_tenant_id, v_spinning_id, v_mock_ids[idx], v_slot, v_slot + interval '1 hour',
            60, 'SAL-DEMO-' || lpad(v_n::text, 4, '0'), 'confirmada', 0);
    v_n := v_n + 1;
  END LOOP;

  RAISE NOTICE 'Reservas mock creadas: %', v_n - 1;
END $$;

-- =============================================================================
-- Fin del seed. Verificá en la app:
--   - Home admin: hero "Próxima clase" muestra Yoga mañana 8:00
--   - Reservar: 7 días con clases reales
--   - T+1 7:00 Yoga: 8/8 LLENA + CTA "Lista de espera"
--   - Hoy 19:00 Spinning: 6/8 coral con label "¡Quedan 2!"
--   - Hoy 18:00 Funcional: 4/8 normal
-- =============================================================================
