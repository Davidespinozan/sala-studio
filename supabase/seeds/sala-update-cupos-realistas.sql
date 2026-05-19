BEGIN;

-- Update defaults por sala (afecta clases generadas a futuro por cron)
UPDATE recursos SET cupo_max_default = 15 WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'sala-demo') AND slug = 'sala-yoga';
UPDATE recursos SET cupo_max_default = 20 WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'sala-demo') AND slug = 'sala-spinning';
UPDATE recursos SET cupo_max_default = 10 WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'sala-demo') AND slug = 'sala-funcional';

-- Update clases ya generadas (las 311 existentes) para reflejar capacidad real
UPDATE clases c
SET cupo_max = 15
FROM recursos r
WHERE c.recurso_id = r.id
  AND r.slug = 'sala-yoga'
  AND c.status = 'programada';

UPDATE clases c
SET cupo_max = 20
FROM recursos r
WHERE c.recurso_id = r.id
  AND r.slug = 'sala-spinning'
  AND c.status = 'programada';

UPDATE clases c
SET cupo_max = 10
FROM recursos r
WHERE c.recurso_id = r.id
  AND r.slug = 'sala-funcional'
  AND c.status = 'programada';

-- Verificación: ninguna clase con reservas EXISTENTES debe haberse "sobre-llenado"
-- (si Sala Funcional tenía cupo 12 y ahora es 10, una clase con 11 reservas quedaría rota)
DO $$
DECLARE
  v_problemas integer;
BEGIN
  SELECT COUNT(*) INTO v_problemas
  FROM (
    SELECT c.id, c.cupo_max, COUNT(r.id) as reservas_count
    FROM clases c
    LEFT JOIN reservas r ON r.clase_id = c.id AND r.status IN ('confirmada','completada')
    WHERE c.status = 'programada'
    GROUP BY c.id, c.cupo_max
    HAVING COUNT(r.id) > c.cupo_max
  ) sub;

  IF v_problemas > 0 THEN
    RAISE WARNING 'Hay % clases con más reservas que cupo. Revisar antes de continuar.', v_problemas;
  ELSE
    RAISE NOTICE 'OK: todas las clases tienen cupo >= reservas existentes.';
  END IF;
END $$;

COMMIT;
