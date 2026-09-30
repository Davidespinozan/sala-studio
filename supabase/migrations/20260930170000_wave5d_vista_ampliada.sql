-- ============================================================================
-- WAVE 5 · D (DB) — Ampliar v_socio_membresia para los lectores del frontend
-- ----------------------------------------------------------------------------
-- W5-D converge los lectores (useMembresiaActual, useSocioFicha) a la autoridad
-- canónica. Necesitan columnas de display que la vista de W5-A no exponía. Se
-- amplía la vista (misma autoridad: membresia_actual_id + es_membresia_vigente)
-- para que los hooks lean TODO de una sola fuente y NO rederiven vigencia.
--
-- DROP+CREATE (la vista aún no la consume nadie en prod: el frontend no está
-- deployado). Re-GRANT. security_invoker: respeta RLS. Aditiva. BEGIN/COMMIT.
-- ============================================================================

BEGIN;

DROP VIEW IF EXISTS v_socio_membresia;

CREATE VIEW v_socio_membresia
WITH (security_invoker = true) AS
SELECT
  u.id            AS usuario_id,
  u.tenant_id     AS tenant_id,
  m.id            AS membresia_id,
  m.status        AS membresia_status,
  m.tier_id       AS tier_id,
  t.slug          AS tier_slug,
  t.nombre        AS tier_nombre,
  t.tipo          AS tier_tipo,
  t.duracion_dias AS duracion_dias,
  t.clases_incluidas AS clases_incluidas,
  t.es_pase       AS es_pase,
  t.acceso_todas_sucursales AS tier_acceso_todas_sucursales,
  m.periodo_actual_inicio,
  m.periodo_actual_fin,
  m.creditos_restantes,
  m.congelada_at,
  m.cancelada_at,
  m.cancelada_efectiva_at,
  m.sucursal_id,
  m.metodo_pago,
  es_membresia_vigente(m.status, m.periodo_actual_fin) AS vigente
FROM usuarios u
LEFT JOIN membresias m ON m.id = membresia_actual_id(u.id)
LEFT JOIN tiers t      ON t.id = m.tier_id
WHERE u.rol = 'miembro';

COMMENT ON VIEW v_socio_membresia IS
  'W5. Autoridad canónica de lectura: 1 fila por socio con su membresía actual '
  '(membresia_actual_id) + vigente (es_membresia_vigente) + campos de display. '
  'Fuente única para useMembresiaActual/useSocioFicha/useSuscripcion/reportes. '
  'No rederivar vigencia en el front; el cache usuarios.* nunca es autoridad.';

GRANT SELECT ON v_socio_membresia TO authenticated;
GRANT SELECT ON v_socio_membresia TO service_role;

-- ── Self-test (DEVUELVE TABLA): la vista expone las columnas nuevas + vigente ─
CREATE TEMP TABLE _w5d_res(orden int, prueba text, resultado text) ON COMMIT DROP;

DO $$
DECLARE
  v_slug text := 'zz-w5d-' || substr(md5(random()::text), 1, 6);
  v_tenant uuid; v_u uuid; v_tier uuid;
  v_row v_socio_membresia%ROWTYPE;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug,'W5D','gym_libre','activo') RETURNING id INTO v_tenant;
  INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES (v_tenant, v_slug||'-u@sala.dev','U','miembro','activo') RETURNING id INTO v_u;
  INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, tipo, duracion_dias, clases_incluidas)
  VALUES (v_tenant,'w5d-t','Plan W5D',100000,'hibrido',30,8) RETURNING id INTO v_tier;
  INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes, metodo_pago)
  VALUES (v_tenant, v_u, v_tier, 'activa', now(), now()+interval '30 days', 8, 'efectivo');

  SELECT * INTO v_row FROM v_socio_membresia WHERE usuario_id = v_u;
  IF v_row.membresia_id IS NULL THEN RAISE EXCEPTION 'W5D: vista sin membresía'; END IF;
  IF v_row.tier_nombre <> 'Plan W5D' OR v_row.tier_tipo <> 'hibrido' OR v_row.clases_incluidas <> 8
     OR v_row.metodo_pago <> 'efectivo' OR v_row.periodo_actual_inicio IS NULL THEN
    RAISE EXCEPTION 'W5D: faltan columnas de display en la vista'; END IF;
  IF v_row.vigente IS DISTINCT FROM true THEN RAISE EXCEPTION 'W5D: vigente incorrecto'; END IF;
  INSERT INTO _w5d_res VALUES (1, 'v_socio_membresia ampliada: display + vigente OK', 'OK');

  PERFORM cerrar_tenant(v_slug);
END $$;

SELECT orden, prueba, resultado FROM _w5d_res ORDER BY orden;

COMMIT;
