-- =============================================================================
-- S6 — Seed: instructores demo para tenant sala-demo
-- =============================================================================
-- Crea 4 instructores creíbles y los asigna a las clases existentes según la
-- sala. Idempotente: cada instructor se inserta solo si no existe (por nombre),
-- y la asignación a clases solo toca clases sin instructor (instructor_id IS NULL).
--
-- foto_url queda NULL — las fotos se suben desde el admin.
-- =============================================================================

DO $$
DECLARE
  v_tenant uuid;
  v_maria  uuid;
  v_carlos uuid;
  v_sofia  uuid;
  v_diego  uuid;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'sala-demo';
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Tenant sala-demo no existe. Corré supabase/seeds/sala-demo.sql primero.';
  END IF;

  -- ─── María Fernanda Ríos ───
  SELECT id INTO v_maria FROM instructores
  WHERE tenant_id = v_tenant AND nombre = 'María Fernanda Ríos';
  IF v_maria IS NULL THEN
    INSERT INTO instructores (tenant_id, nombre, bio, especialidades, orden)
    VALUES (
      v_tenant, 'María Fernanda Ríos',
      'Instructora certificada con 8 años de experiencia en Vinyasa y Hatha.',
      ARRAY['Yoga', 'Pilates'], 1
    )
    RETURNING id INTO v_maria;
  END IF;

  -- ─── Carlos Mendoza ───
  SELECT id INTO v_carlos FROM instructores
  WHERE tenant_id = v_tenant AND nombre = 'Carlos Mendoza';
  IF v_carlos IS NULL THEN
    INSERT INTO instructores (tenant_id, nombre, bio, especialidades, orden)
    VALUES (
      v_tenant, 'Carlos Mendoza',
      'Coach de ciclismo indoor, energía pura en cada clase.',
      ARRAY['Spinning', 'HIIT'], 2
    )
    RETURNING id INTO v_carlos;
  END IF;

  -- ─── Sofía Herrera ───
  SELECT id INTO v_sofia FROM instructores
  WHERE tenant_id = v_tenant AND nombre = 'Sofía Herrera';
  IF v_sofia IS NULL THEN
    INSERT INTO instructores (tenant_id, nombre, bio, especialidades, orden)
    VALUES (
      v_tenant, 'Sofía Herrera',
      'Especialista en yoga restaurativo y mindfulness.',
      ARRAY['Yoga', 'Meditación'], 3
    )
    RETURNING id INTO v_sofia;
  END IF;

  -- ─── Diego Torres ───
  SELECT id INTO v_diego FROM instructores
  WHERE tenant_id = v_tenant AND nombre = 'Diego Torres';
  IF v_diego IS NULL THEN
    INSERT INTO instructores (tenant_id, nombre, bio, especialidades, orden)
    VALUES (
      v_tenant, 'Diego Torres',
      'Entrenador funcional, enfoque en fuerza y movilidad.',
      ARRAY['Crossfit', 'Funcional'], 4
    )
    RETURNING id INTO v_diego;
  END IF;

  -- ─── Asignar instructores a clases por sala (solo las que no tienen uno) ───
  -- Se matchea por recurso.slug (más robusto que por disciplina string).
  UPDATE clases c
  SET instructor_id = v_maria
  FROM recursos r
  WHERE c.recurso_id = r.id
    AND c.tenant_id = v_tenant
    AND r.slug = 'sala-yoga'
    AND c.instructor_id IS NULL;

  UPDATE clases c
  SET instructor_id = v_carlos
  FROM recursos r
  WHERE c.recurso_id = r.id
    AND c.tenant_id = v_tenant
    AND r.slug = 'sala-spinning'
    AND c.instructor_id IS NULL;

  UPDATE clases c
  SET instructor_id = v_diego
  FROM recursos r
  WHERE c.recurso_id = r.id
    AND c.tenant_id = v_tenant
    AND r.slug = 'sala-funcional'
    AND c.instructor_id IS NULL;

  RAISE NOTICE 'Instructores demo OK. Yoga→María Fernanda, Spinning→Carlos, Funcional→Diego. Sofía queda disponible para asignación manual.';
END $$;
