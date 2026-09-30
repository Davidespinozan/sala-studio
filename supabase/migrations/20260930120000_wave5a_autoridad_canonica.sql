-- ============================================================================
-- WAVE 5 · A — Autoridad canónica de membresía (definición única)
-- ----------------------------------------------------------------------------
-- Decisiones de owner (cerradas 2026-09-30):
--   D-W5-1 VIGENCIA: vigente = status='activa' AND periodo_actual_fin >= now.
--     · fin NULL (créditos puros que no caducan) => sigue vigente si 'activa'.
--     · past_due NO vigente; congelada NO vigente (dunning/Stripe = W6).
--   D-W5-2 SOCIO ACTIVO = membresía vigente (no usuarios.status='activo').
--   D-W5-4 CACHE (usuarios.membresia_activa_id/tier) = derivado; autoridad =
--     membresias + este selector/predicado.
--
-- Esta pieza SOLO crea la autoridad canónica (predicado + selector + vista).
-- Es 100% aditiva: nada la consume todavía (W5-D cablea a los lectores). No
-- cambia el comportamiento de ningún RPC/gate. BEGIN/COMMIT + self-tests.
-- No toca W1-W4, huella, ni las 31 divergencias.
-- ============================================================================

BEGIN;

-- ── Predicado canónico de VIGENCIA (D-W5-1) ─────────────────────────────────
-- STABLE porque depende de now() (estable dentro de un statement).
CREATE OR REPLACE FUNCTION es_membresia_vigente(p_status text, p_periodo_fin timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT p_status = 'activa' AND (p_periodo_fin IS NULL OR p_periodo_fin >= now());
$$;

COMMENT ON FUNCTION es_membresia_vigente(text, timestamptz) IS
  'W5. Predicado canónico de vigencia (D-W5-1): activa AND (fin NULL [créditos '
  'sin vencimiento] OR fin>=now). past_due/congelada NO son vigentes.';

-- ── Selector canónico de "membresía ACTUAL" de un socio ─────────────────────
-- Un único orden de prioridad, reemplaza los ≥8 selectores ad-hoc. Prioriza el
-- estado más "vivo" y, a igualdad, la más reciente.
CREATE OR REPLACE FUNCTION membresia_actual_id(p_usuario uuid)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT id
  FROM membresias
  WHERE usuario_id = p_usuario
  ORDER BY
    CASE status
      WHEN 'activa'    THEN 0
      WHEN 'past_due'  THEN 1
      WHEN 'congelada' THEN 2
      WHEN 'trialing'  THEN 3
      WHEN 'expirada'  THEN 4
      WHEN 'pendiente' THEN 5
      ELSE 6              -- cancelada
    END,
    created_at DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION membresia_actual_id(uuid) IS
  'W5. Selector canónico único de la membresía ACTUAL de un socio (prioridad de '
  'estado + created_at DESC). Reemplaza los selectores ad-hoc dispersos.';

-- ── Vista canónica por socio (autoridad de lectura para el frontend) ────────
-- security_invoker: respeta la RLS de membresias/usuarios (el socio ve la suya;
-- recepción/admin las de su tenant). Reemplaza las definiciones paralelas de
-- "vigente/actual" en useMembresiaActual/useSocioFicha/Dashboard (W5-D).
CREATE OR REPLACE VIEW v_socio_membresia
WITH (security_invoker = true) AS
SELECT
  u.id            AS usuario_id,
  u.tenant_id     AS tenant_id,
  m.id            AS membresia_id,
  m.status        AS membresia_status,
  m.tier_id       AS tier_id,
  t.slug          AS tier_slug,
  t.tipo          AS tier_tipo,
  m.periodo_actual_fin,
  m.creditos_restantes,
  m.congelada_at,
  m.cancelada_at,
  es_membresia_vigente(m.status, m.periodo_actual_fin) AS vigente
FROM usuarios u
LEFT JOIN membresias m ON m.id = membresia_actual_id(u.id)
LEFT JOIN tiers t      ON t.id = m.tier_id
WHERE u.rol = 'miembro';

COMMENT ON VIEW v_socio_membresia IS
  'W5. Autoridad canónica de lectura: 1 fila por socio con su membresía actual '
  '(selector canónico) y vigente (predicado canónico). Los lectores del front '
  'deben converger a esta vista (W5-D); no crear definiciones paralelas.';

GRANT SELECT ON v_socio_membresia TO authenticated;
GRANT SELECT ON v_socio_membresia TO service_role;


-- ============================================================================
-- SELF-TESTS (DEVUELVEN TABLA) — predicado sin datos; selector/vista con tenant
-- desechable que cerrar_tenant limpia. RAISE en cualquier fallo revierte todo.
-- ============================================================================
CREATE TEMP TABLE _w5a_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $$
DECLARE
  v_slug text := 'zz-w5a-' || substr(md5(random()::text), 1, 6);
  v_tenant uuid;
  v_u1 uuid;  -- activa vigente (+ expirada vieja) → actual debe ser la activa
  v_u2 uuid;  -- activa vencida (fin pasado) → no vigente
  v_u3 uuid;  -- créditos puros (fin NULL) activa → vigente
  v_tier_t uuid; v_tier_c uuid;
  v_actual uuid; v_mact uuid; v_vig boolean;
BEGIN
  -- Predicado (sin datos)
  IF NOT es_membresia_vigente('activa', now() + interval '10 days') THEN RAISE EXCEPTION 'P1: activa+futuro debería ser vigente'; END IF;
  IF es_membresia_vigente('activa', now() - interval '1 day') THEN RAISE EXCEPTION 'P2: activa+pasado NO debe ser vigente'; END IF;
  IF NOT es_membresia_vigente('activa', NULL) THEN RAISE EXCEPTION 'P3: activa+NULL (créditos) debe ser vigente'; END IF;
  IF es_membresia_vigente('past_due', now() + interval '10 days') THEN RAISE EXCEPTION 'P4: past_due NO vigente'; END IF;
  IF es_membresia_vigente('congelada', now() + interval '10 days') THEN RAISE EXCEPTION 'P5: congelada NO vigente'; END IF;
  IF es_membresia_vigente('expirada', NULL) THEN RAISE EXCEPTION 'P6: expirada NO vigente'; END IF;
  IF es_membresia_vigente('cancelada', now() + interval '10 days') THEN RAISE EXCEPTION 'P7: cancelada NO vigente'; END IF;
  INSERT INTO _w5a_res VALUES (1, 'es_membresia_vigente: 7 casos (incl. fin NULL=vigente, past_due/congelada=no)', 'OK');

  -- Setup
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug,'W5A','gym_libre','activo') RETURNING id INTO v_tenant;
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, duracion_dias) VALUES (v_tenant,'w5a-t','Tiempo',100000,'tiempo',30) RETURNING id INTO v_tier_t;
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, clases_incluidas) VALUES (v_tenant,'w5a-c','Créditos',100000,'creditos',10) RETURNING id INTO v_tier_c;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-u1@sala.dev','U1','miembro','activo') RETURNING id INTO v_u1;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-u2@sala.dev','U2','miembro','activo') RETURNING id INTO v_u2;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-u3@sala.dev','U3','miembro','activo') RETURNING id INTO v_u3;

  -- U1: una expirada vieja + una activa vigente (creadas en ese orden).
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, created_at)
  VALUES (v_tenant, v_u1, v_tier_t, 'expirada', now()-interval '60 days', now()-interval '30 days', now()-interval '60 days');
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, created_at)
  VALUES (v_tenant, v_u1, v_tier_t, 'activa', now()-interval '5 days', now()+interval '25 days', now()-interval '5 days') RETURNING id INTO v_mact;

  -- U2: activa pero vencida (fin pasado) → actual=esa, vigente=false.
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin)
  VALUES (v_tenant, v_u2, v_tier_t, 'activa', now()-interval '40 days', now()-interval '1 day');

  -- U3: créditos puros activa, fin NULL → vigente=true.
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes)
  VALUES (v_tenant, v_u3, v_tier_c, 'activa', now()-interval '2 days', NULL, 8);

  -- T2: selector elige la activa (no la expirada) de U1.
  v_actual := membresia_actual_id(v_u1);
  IF v_actual <> v_mact THEN RAISE EXCEPTION 'T2: membresia_actual_id no eligió la activa (=%)', v_actual; END IF;
  INSERT INTO _w5a_res VALUES (2, 'membresia_actual_id: con expirada+activa elige la ACTIVA (prioridad)', 'OK');

  -- T3: vista — U1 vigente, U2 no vigente (activa vencida), U3 vigente (fin NULL).
  SELECT vigente INTO v_vig FROM v_socio_membresia WHERE usuario_id = v_u1;
  IF v_vig IS DISTINCT FROM true THEN RAISE EXCEPTION 'T3: U1 debería ser vigente'; END IF;
  SELECT vigente INTO v_vig FROM v_socio_membresia WHERE usuario_id = v_u2;
  IF v_vig IS DISTINCT FROM false THEN RAISE EXCEPTION 'T3: U2 (activa vencida) NO debería ser vigente (=%)', v_vig; END IF;
  SELECT vigente INTO v_vig FROM v_socio_membresia WHERE usuario_id = v_u3;
  IF v_vig IS DISTINCT FROM true THEN RAISE EXCEPTION 'T3: U3 (créditos fin NULL) debería ser vigente (=%)', v_vig; END IF;
  INSERT INTO _w5a_res VALUES (3, 'v_socio_membresia: vigente correcto (U1 sí, U2 vencida no, U3 créditos-NULL sí)', 'OK');

  -- T4: la vista devuelve exactamente 1 fila por socio miembro.
  IF (SELECT count(*) FROM v_socio_membresia WHERE usuario_id = v_u1) <> 1 THEN
    RAISE EXCEPTION 'T4: la vista no devolvió 1 fila única por socio'; END IF;
  INSERT INTO _w5a_res VALUES (4, 'v_socio_membresia: 1 fila por socio', 'OK');

  PERFORM cerrar_tenant(v_slug);
END $$;

SELECT orden, prueba, resultado FROM _w5a_res ORDER BY orden;

COMMIT;
