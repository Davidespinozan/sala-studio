-- ============================================================================
-- DEMO HEALTHYSPACE · Lote 4 — socios + membresías
-- ----------------------------------------------------------------------------
-- Siembra 40 socios con nombres realistas y altas escalonadas en ~6 meses, cada
-- uno con una membresía (Básica o Pro). ~1 de cada 9 está cancelado → da churn
-- y vida (LTV) reales en el bloque de Economía; el resto activos → MRR/ARR/ARPU.
--
-- created_at va HACIA ATRÁS (18-174 días) por dos razones: (1) el reset nocturno
-- solo borra socios/membresías creados en las últimas 25h, así que el seed
-- sobrevive; (2) da una curva de altas por mes para los reportes.
--
-- Socios sin auth_id (no inician sesión; son data para listas y reportes). El
-- visitante "miembro" del demo es el usuario anónimo que crea provisionar_demo,
-- no estos.
--
-- Idempotente: limpia el seed previo (emails socioN@healthyspace.demo) y reinserta.
-- ============================================================================

-- ── Limpieza del seed previo (orden por FKs) ────────────────────────────────
UPDATE usuarios SET membresia_activa_id = NULL
WHERE email LIKE 'socio%@healthyspace.demo';
DELETE FROM membresias
WHERE usuario_id IN (SELECT id FROM usuarios WHERE email LIKE 'socio%@healthyspace.demo');
DELETE FROM usuarios
WHERE email LIKE 'socio%@healthyspace.demo';

-- ── 1) Socios ───────────────────────────────────────────────────────────────
INSERT INTO usuarios (tenant_id, email, nombre, telefono, rol, status, membresia_tier, created_at)
SELECT
  t.id,
  'socio' || g || '@healthyspace.demo',
  fn.arr[1 + (g % array_length(fn.arr, 1))] || ' ' || ln.arr[1 + ((g * 7) % array_length(ln.arr, 1))],
  '+5266' || lpad(((g * 137 + 1000000) % 100000000)::text, 8, '0'),
  'miembro',
  CASE WHEN g % 9 = 0 THEN 'cancelado' ELSE 'activo' END,
  CASE WHEN g % 2 = 0 THEN 'pro' ELSE 'basica' END,
  now() - make_interval(days => 178 - g * 4)
FROM
  (SELECT id FROM tenants WHERE slug = 'healthyspace') t,
  (SELECT ARRAY['Sofía','Mateo','Valentina','Santiago','Camila','Diego','Regina','Emiliano',
                'Ximena','Sebastián','Renata','Leonardo','Victoria','Andrés','Daniela',
                'Maximiliano','Fernanda','Joaquín','Isabela','Rodrigo'] AS arr) fn,
  (SELECT ARRAY['García','Martínez','López','Hernández','González','Rodríguez','Pérez',
                'Sánchez','Ramírez','Torres','Flores','Rivera','Gómez','Díaz','Reyes',
                'Cruz','Morales','Ortiz','Gutiérrez','Mendoza'] AS arr) ln,
  generate_series(1, 40) g;

-- ── 2) Membresías (1 por socio) ─────────────────────────────────────────────
-- Activos: membresía 'activa', periodo en curso (vence en ~15 días).
-- Cancelados: 'cancelada', con fecha de baja reciente → alimenta churn y vida.
INSERT INTO membresias
  (tenant_id, usuario_id, tier_id, status,
   periodo_actual_inicio, periodo_actual_fin, commitment_ends_at,
   cancelada_at, cancelada_efectiva_at, created_at)
SELECT
  u.tenant_id, u.id, ti.id,
  CASE WHEN u.status = 'cancelado' THEN 'cancelada' ELSE 'activa' END,
  CASE WHEN u.status = 'cancelado'
       THEN date_trunc('month', now()) - interval '1 month'
       ELSE now() - interval '15 days' END,
  CASE WHEN u.status = 'cancelado'
       THEN date_trunc('month', now())
       ELSE now() + interval '15 days' END,
  u.created_at + interval '6 months',
  CASE WHEN u.status = 'cancelado' THEN now() - interval '20 days' ELSE NULL END,
  CASE WHEN u.status = 'cancelado' THEN now() -  interval '5 days' ELSE NULL END,
  u.created_at
FROM usuarios u
JOIN tiers ti ON ti.tenant_id = u.tenant_id AND ti.slug = u.membresia_tier
WHERE u.email LIKE 'socio%@healthyspace.demo';

-- ── 3) Linkear la membresía activa al socio ─────────────────────────────────
UPDATE usuarios u
SET membresia_activa_id = m.id
FROM membresias m
WHERE m.usuario_id = u.id
  AND m.status = 'activa'
  AND u.email LIKE 'socio%@healthyspace.demo';
