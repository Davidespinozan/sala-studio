-- ============================================================================
-- DEMO HEALTHYSPACE · Lote 5 — reservas + check-ins
-- ----------------------------------------------------------------------------
-- Materializa las clases de la parrilla en una ventana [-28, +10] días y las
-- llena con reservas de los socios activos. Resultado:
--   - Agenda/calendario del admin: clases con ocupación real.
--   - Recepción: lista de check-in de HOY (reservas confirmadas de hoy).
--   - Reportes: asistencia, no-shows, heatmap día×hora, rendimiento por sala.
--
-- Detalles:
--   - Llenado por horario → mañana ~55%, mediodía ~50%, tarde/noche ~90% del
--     cupo. Eso dibuja un heatmap creíble (las noches "calientes").
--   - Clases pasadas → reservas 'completada' (con check-in) salvo ~1/8 'no_show'.
--     Clases de hoy/futuras → 'confirmada'.
--   - reservas.created_at va 3-20 días hacia atrás: sobrevive el reset nocturno
--     (que solo borra reservas creadas en las últimas 25h) y es realista.
--   - clase.sucursal_id se toma de la sala (no del default) → reportes por sede ok.
--
-- Idempotente: borra reservas y clases del tenant y reconstruye (el demo no tenía
-- reservas reales; las clases son virtuales/regenerables).
-- ============================================================================

-- ── Limpieza (reservas antes que clases por la FK clase_id) ─────────────────
DELETE FROM reservas WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'healthyspace');
DELETE FROM clases   WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'healthyspace');

-- ── 1) Materializar clases de la parrilla en la ventana ─────────────────────
INSERT INTO clases
  (tenant_id, recurso_id, sucursal_id, fecha, hora_inicio, duracion_minutos, nombre,
   cupo_max, instructor_id, origen, horario_recurrente_id, status, created_at)
SELECT
  h.tenant_id, h.recurso_id, r.sucursal_id, d::date, h.hora_inicio, h.duracion_minutos, h.nombre,
  COALESCE(h.cupo_max, r.cupo_max_default, 12),
  h.instructor_id, 'recurrente', h.id,
  CASE WHEN d::date < current_date THEN 'completada' ELSE 'programada' END,
  now() - interval '35 days'
FROM horarios_recurrentes h
JOIN recursos r ON r.id = h.recurso_id
CROSS JOIN generate_series((current_date - 28)::timestamp, (current_date + 10)::timestamp, interval '1 day') AS d
WHERE h.tenant_id = (SELECT id FROM tenants WHERE slug = 'healthyspace')
  AND EXTRACT(DOW FROM d)::int = ANY(h.dias_semana);

-- ── 2) Reservas (llenado por horario) + check-ins ───────────────────────────
INSERT INTO reservas
  (tenant_id, recurso_id, usuario_id, clase_id, slot_inicio, slot_fin, duracion_min,
   folio, status, check_in_at, created_at)
SELECT
  q.tenant_id, q.recurso_id, q.usuario_id, q.clase_id, q.slot_inicio, q.slot_fin, q.duracion_minutos,
  'HS-' || lpad((row_number() OVER (ORDER BY q.slot_inicio, q.clase_id, q.usuario_id))::text, 6, '0'),
  q.status,
  CASE WHEN q.status = 'completada' THEN q.slot_inicio + interval '4 minutes' ELSE NULL END,
  now() - make_interval(days => 3 + (q.rn % 18)::int)
FROM (
  SELECT b.*,
    CASE WHEN b.fecha < current_date
         THEN CASE WHEN b.rn % 8 = 0 THEN 'no_show' ELSE 'completada' END
         ELSE 'confirmada' END AS status
  FROM (
    SELECT
      c.tenant_id, c.recurso_id, c.id AS clase_id, c.fecha, c.cupo_max, c.duracion_minutos, c.hora_inicio,
      (c.fecha + c.hora_inicio)::timestamptz AS slot_inicio,
      (c.fecha + c.hora_inicio)::timestamptz + make_interval(mins => c.duracion_minutos) AS slot_fin,
      u.id AS usuario_id,
      row_number() OVER (PARTITION BY c.id ORDER BY md5(c.id::text || u.id::text)) AS rn,
      CASE WHEN c.hora_inicio <  time '10:00' THEN 0.55
           WHEN c.hora_inicio >= time '18:00' THEN 0.90
           ELSE 0.50 END AS fill
    FROM clases c
    JOIN usuarios u
      ON u.tenant_id = c.tenant_id
     AND u.rol = 'miembro' AND u.status = 'activo'
     AND u.email LIKE 'socio%@healthyspace.demo'
    WHERE c.tenant_id = (SELECT id FROM tenants WHERE slug = 'healthyspace')
  ) b
  WHERE b.rn <= ceil(b.cupo_max * b.fill)
) q;
