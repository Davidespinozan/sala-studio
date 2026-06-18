-- ============================================================================
-- DEMO HEALTHYSPACE · seed de Bitácora (auditoria_recepcion)
-- ----------------------------------------------------------------------------
-- El demo no tenía movimientos de recepción (las reservas se sembraron directo,
-- no vía acciones de staff), así que la Bitácora salía vacía. Sembramos ~24
-- movimientos variados (check-ins, renovaciones, congelar plan, notas, etc.)
-- backdated, atribuidos a un staff del tenant y a socios reales del seed.
--
-- Idempotente: borra los movimientos del tenant y reinserta (el demo no tiene
-- auditoría "real" que perder).
-- ============================================================================

DELETE FROM auditoria_recepcion
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'healthyspace');

INSERT INTO auditoria_recepcion
  (tenant_id, actor_id, actor_nombre, actor_rol, accion, entidad, socio_id, socio_nombre, resumen, creado_en)
SELECT
  t.id, st.id, st.nombre, st.rol,
  a.accion, a.entidad, s.id, s.nombre,
  a.resumen || ' de ' || split_part(s.nombre, ' ', 1),
  now() - make_interval(days => g::int, hours => (g * 5 % 12)::int)
FROM
  (SELECT id FROM tenants WHERE slug = 'healthyspace') t
  CROSS JOIN LATERAL (
    SELECT u.id, u.nombre, u.rol
    FROM usuarios u
    WHERE u.tenant_id = t.id AND u.rol IN ('admin', 'recepcionista')
    ORDER BY CASE u.rol WHEN 'recepcionista' THEN 0 ELSE 1 END
    LIMIT 1
  ) st
  CROSS JOIN generate_series(1, 24) g
  CROSS JOIN LATERAL (
    SELECT accion, entidad, resumen
    FROM (VALUES
      (0, 'checkin.qr',                 'checkin',   'Check-in con QR'),
      (1, 'membresia.renovar',          'membresia', 'Renovó el plan'),
      (2, 'checkin.manual',             'checkin',   'Check-in manual'),
      (3, 'membresia.congelar',         'membresia', 'Congeló la membresía'),
      (4, 'socio.nota',                 'socio',     'Agregó una nota'),
      (5, 'membresia.cambiar_plan',     'membresia', 'Cambió de plan'),
      (6, 'reserva.crear',              'reserva',   'Creó una reserva'),
      (7, 'membresia.recargar_creditos','membresia', 'Recargó créditos')
    ) v(k, accion, entidad, resumen)
    WHERE v.k = g % 8
  ) a
  CROSS JOIN LATERAL (
    SELECT u.id, u.nombre
    FROM usuarios u
    WHERE u.tenant_id = t.id AND u.rol = 'miembro' AND u.email LIKE 'socio%@healthyspace.demo'
    ORDER BY md5(u.id::text || g::text)
    LIMIT 1
  ) s;
