-- ============================================================================
-- ¿QUÉ TENANTS EXISTEN REALMENTE?
-- ----------------------------------------------------------------------------
-- Deberían ser solo dos: healthyspace (demo) y numawellness (cliente real).
-- El self-test de la migración anterior listó 4 salas abiertas, y una se llama
-- "Juan Pablo Escobar" — o sea que hay tenants de más. Esto los saca a la luz.
-- Solo LEE: no borra ni cambia nada.
-- ============================================================================

-- ── 1) Todos los tenants, con su tamaño real ────────────────────────────────
SELECT
  t.slug,
  t.nombre,
  t.status,
  to_char(t.created_at, 'DD/MM/YYYY') AS creado,
  (SELECT count(*) FROM usuarios  u WHERE u.tenant_id = t.id) AS usuarios,
  (SELECT count(*) FROM usuarios  u WHERE u.tenant_id = t.id AND u.rol = 'miembro') AS socios,
  (SELECT count(*) FROM recursos  r WHERE r.tenant_id = t.id) AS salas,
  (SELECT count(*) FROM reservas  x WHERE x.tenant_id = t.id) AS reservas,
  (SELECT count(*) FROM pagos     p WHERE p.tenant_id = t.id) AS pagos,
  CASE
    WHEN t.slug IN ('healthyspace', 'numawellness') THEN 'ESPERADO'
    ELSE '⚠️ NO DEBERÍA EXISTIR'
  END AS veredicto
FROM tenants t
ORDER BY t.created_at;

-- ── 2) Las salas, para ubicar de quién es cada una ──────────────────────────
SELECT
  t.slug AS tenant,
  r.nombre AS sala,
  r.activo,
  cardinality(r.tiers_permitidos) AS planes_con_acceso,
  (SELECT count(*) FROM reservas x WHERE x.recurso_id = r.id) AS reservas
FROM recursos r
JOIN tenants t ON t.id = r.tenant_id
ORDER BY t.slug, r.nombre;

-- ── 3) Los usuarios de los tenants que NO deberían existir ──────────────────
-- Si esto devuelve gente con reservas o pagos, NO es basura de pruebas.
SELECT
  t.slug AS tenant,
  u.rol,
  u.email,
  u.nombre,
  to_char(u.created_at, 'DD/MM/YYYY') AS creado
FROM usuarios u
JOIN tenants t ON t.id = u.tenant_id
WHERE t.slug NOT IN ('healthyspace', 'numawellness')
ORDER BY t.slug, u.rol, u.created_at;
