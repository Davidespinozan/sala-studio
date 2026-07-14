-- ============================================================================
-- Dar de baja un gym era imposible
-- ----------------------------------------------------------------------------
-- No hay forma de borrar un tenant. Las llaves foráneas se traban entre sí:
--
--   tenants  ←RESTRICT─ usuarios      (no borrás el gym si tiene gente)
--   usuarios ←RESTRICT─ reservas      (no borrás la gente si reservó)
--   usuarios ←RESTRICT─ pagos         (no borrás la gente si pagó)
--   pagos: trigger append-only        (no borrás el pago, nunca, ni en cascada)
--
-- Cada RESTRICT está bien puesto por separado —protegen el historial de plata—,
-- pero juntos significan que un gym que cobró una sola vez queda en la base para
-- siempre. Y el error que sale ('PAGOS_APPEND_ONLY') no dice nada de eso.
--
-- En vez de aflojar las llaves (que es lo que protege el ledger del día a día),
-- se agrega la operación que faltaba: CERRAR un tenant. Desarma en el orden
-- correcto, se lleva las cuentas de auth, y es lo único ante lo que el trigger
-- de pagos cede — vía un flag de transacción que solo esta función prende.
--
-- Es la primitiva que el SaaS va a necesitar igual el día que un gym se dé de
-- baja. Hoy la usamos para limpiar los tenants de prueba.
-- ============================================================================

-- ── El trigger de pagos cede SOLO ante un cierre de tenant ──────────────────
-- UPDATE y DELETE directo siguen bloqueados siempre. La garantía del ledger no
-- se toca: un pago no se edita ni se borra. Lo único que se habilita es que el
-- cierre de un gym se lleve su historial con él, que es lo que un cierre es.
CREATE OR REPLACE FUNCTION trg_pagos_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('sala.cierre_tenant', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'PAGOS_APPEND_ONLY: un pago no se edita ni se borra; registrá un asiento de corrección';
END;
$$;

COMMENT ON FUNCTION trg_pagos_append_only() IS
  'Append-only de pagos. UPDATE y DELETE siempre bloqueados, salvo el DELETE que '
  'ocurre dentro de cerrar_tenant() (que prende el flag sala.cierre_tenant). Sin '
  'esa excepción, un gym que cobró alguna vez no se podría dar de baja jamás.';


-- ── Cerrar un tenant: el desarme completo, en orden ─────────────────────────
CREATE OR REPLACE FUNCTION cerrar_tenant(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_auth_ids uuid[];
  v_usuarios integer;
  v_reservas integer;
  v_pagos integer;
  v_auth integer;
BEGIN
  SELECT id INTO v_tenant_id FROM tenants WHERE slug = p_slug;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'TENANT_NO_EXISTE: No hay ningún gym con el slug "%"', p_slug;
  END IF;

  -- Las cuentas de auth hay que guardarlas ANTES de borrar usuarios: después no
  -- queda de dónde sacarlas y quedarían huérfanas, ocupando el email para
  -- siempre (auth.users.email es único).
  SELECT COALESCE(array_agg(auth_id), ARRAY[]::uuid[])
  INTO v_auth_ids
  FROM usuarios
  WHERE tenant_id = v_tenant_id AND auth_id IS NOT NULL;

  -- El flag vive solo en ESTA transacción (el tercer parámetro = is_local).
  PERFORM set_config('sala.cierre_tenant', 'on', true);

  DELETE FROM pagos    WHERE tenant_id = v_tenant_id;
  GET DIAGNOSTICS v_pagos = ROW_COUNT;

  DELETE FROM reservas WHERE tenant_id = v_tenant_id;
  GET DIAGNOSTICS v_reservas = ROW_COUNT;

  -- Ahora sí: ya nada RESTRICT-ea a los usuarios.
  DELETE FROM usuarios WHERE tenant_id = v_tenant_id;
  GET DIAGNOSTICS v_usuarios = ROW_COUNT;

  -- Y el tenant se lleva en cascada todo lo demás (salas, clases, horarios,
  -- planes, membresías, suscripción al SaaS, bitácora...).
  DELETE FROM tenants WHERE id = v_tenant_id;

  -- Las cuentas de login. Sin esto el email queda tomado y esa persona no se
  -- puede volver a registrar nunca.
  DELETE FROM auth.users WHERE id = ANY(v_auth_ids);
  GET DIAGNOSTICS v_auth = ROW_COUNT;

  PERFORM set_config('sala.cierre_tenant', 'off', true);

  RETURN jsonb_build_object(
    'success', true,
    'slug', p_slug,
    'usuarios_borrados', v_usuarios,
    'reservas_borradas', v_reservas,
    'pagos_borrados', v_pagos,
    'cuentas_auth_borradas', v_auth
  );
END;
$$;

-- Cerrar un gym NO es una acción de la app: no la puede llamar nadie desde el
-- navegador. Solo service_role (y el postgres del SQL Editor).
REVOKE ALL ON FUNCTION cerrar_tenant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION cerrar_tenant(text) FROM anon;
REVOKE ALL ON FUNCTION cerrar_tenant(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION cerrar_tenant(text) TO service_role;

COMMENT ON FUNCTION cerrar_tenant(text) IS
  'Baja definitiva de un gym: borra pagos, reservas, usuarios, el tenant (que '
  'cascadea el resto) y las cuentas de auth. Irreversible. Solo service_role.';


-- ============================================================================
-- SELF-TEST: el ledger sigue siendo append-only; el cierre sí se lo lleva.
-- ============================================================================
DO $$
DECLARE
  v_tenant uuid;
  v_usuario uuid;
  v_pago uuid;
  v_slug text := 'zz-test-cierre-' || substr(md5(random()::text), 1, 6);
  v_update_bloqueado boolean := false;
  v_delete_bloqueado boolean := false;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test cierre', 'gym_libre', 'activo')
  RETURNING id INTO v_tenant;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug || '@sala.dev', 'Test', 'miembro', 'activo')
  RETURNING id INTO v_usuario;

  INSERT INTO pagos (tenant_id, usuario_id, concepto, metodo, monto_centavos, moneda)
  VALUES (v_tenant, v_usuario, 'plan', 'efectivo', 10000, 'MXN')
  RETURNING id INTO v_pago;

  -- 1) Un pago no se edita.
  BEGIN
    UPDATE pagos SET monto_centavos = 1 WHERE id = v_pago;
  EXCEPTION WHEN OTHERS THEN
    v_update_bloqueado := true;
  END;

  -- 2) Un pago no se borra a mano.
  BEGIN
    DELETE FROM pagos WHERE id = v_pago;
  EXCEPTION WHEN OTHERS THEN
    v_delete_bloqueado := true;
  END;

  IF NOT v_update_bloqueado THEN
    RAISE EXCEPTION 'REGRESIÓN: se pudo EDITAR un pago';
  END IF;
  IF NOT v_delete_bloqueado THEN
    RAISE EXCEPTION 'REGRESIÓN: se pudo BORRAR un pago a mano';
  END IF;

  -- 3) Pero cerrar el gym sí se lo lleva.
  PERFORM cerrar_tenant(v_slug);

  IF EXISTS (SELECT 1 FROM tenants WHERE id = v_tenant) THEN
    RAISE EXCEPTION 'FALLA: el tenant sobrevivió al cierre';
  END IF;
  IF EXISTS (SELECT 1 FROM pagos WHERE id = v_pago) THEN
    RAISE EXCEPTION 'FALLA: el pago sobrevivió al cierre del tenant';
  END IF;
  IF EXISTS (SELECT 1 FROM usuarios WHERE id = v_usuario) THEN
    RAISE EXCEPTION 'FALLA: el usuario sobrevivió al cierre del tenant';
  END IF;
END;
$$;

SELECT 'un pago no se edita ni se borra a mano' AS prueba,
       'bloqueado' AS espera, 'OK' AS resultado
UNION ALL
SELECT 'cerrar_tenant() sí se lleva pagos, usuarios y tenant',
       'todo borrado', 'OK'
UNION ALL
SELECT 'cerrar_tenant() no la puede llamar la app',
       'sin EXECUTE para authenticated',
       CASE WHEN has_function_privilege('authenticated', 'cerrar_tenant(text)', 'EXECUTE')
            THEN 'FALLA' ELSE 'OK' END;
