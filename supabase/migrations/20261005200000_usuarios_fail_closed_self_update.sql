-- POST-W6 · #13 usuarios MASS-ASSIGNMENT RESIDUAL — hardening fail-closed.
--
-- Auditoría confirmó: ningún caller legítimo depende de que un miembro pueda
-- hacer UPDATE directo sobre su propia fila de usuarios (self-service real ya
-- es 100% RPC-mediado, vía socio_actualizar_perfil). La policy usuarios_update_self
-- (RLS) + trg_proteger_usuarios (blocklist de 7 columnas) dejaban abiertas
-- stripe_customer_id / sucursal_id / notas_admin / cualquier columna futura a
-- un PATCH directo por PostgREST, sin ningún beneficio funcional a cambio.
--
-- Fix (defensa en 2 capas + 1 guard adicional):
--  1) Se elimina usuarios_update_self: un miembro ya no puede ni intentar un
--     UPDATE directo sobre su propia fila (RLS lo filtra a 0 filas). admin
--     sigue intacto vía usuarios_update_admin (no se toca).
--  2) trg_proteger_usuarios pasa de blocklist (7 columnas nombradas) a
--     allowlist real (0 columnas): para authenticated/anon no-admin, CUALQUIER
--     cambio de fila (NEW IS DISTINCT FROM OLD, compara el row completo) queda
--     bloqueado — cubre las 7 columnas de antes Y cualquier columna que se
--     agregue en el futuro, sin tener que acordarse de agregarla a una lista.
--     Se preserva VERBATIM el backstop C3 (último admin activo).
--  3) Nuevo guard, universal (aplica también a admin): si sucursal_id cambia a
--     un valor no NULL, esa sucursal debe pertenecer al mismo tenant_id de la
--     fila. NULL sigue permitido sin restricción (comportamiento existente).

CREATE OR REPLACE FUNCTION trg_proteger_usuarios()
RETURNS trigger
LANGUAGE plpgsql
-- SECURITY INVOKER (default): necesitamos el current_user REAL del ejecutor.
AS $$
BEGIN
  -- C1 (extendido, #13): un end-user autenticado no-admin no puede tocar NADA
  -- de su propia fila (ni de ninguna) vía UPDATE directo — allowlist real,
  -- no blocklist. El self-service legítimo (perfil, teléfono, etc.) pasa por
  -- RPCs SECURITY DEFINER (socio_actualizar_perfil y similares), que corren
  -- como owner (current_user != authenticated/anon) y nunca llegan a este IF.
  IF current_user IN ('authenticated', 'anon') AND NOT is_admin() THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION
        'PRIVILEGIO_DENEGADO: no podés modificar tu fila de usuarios directamente; usá los RPCs de autoservicio.';
    END IF;
  END IF;

  -- C3 — backstop absoluto: nunca dejar el tenant sin ningún admin activo.
  -- VERBATIM de la versión anterior (20260928140000), sin cambios.
  IF OLD.rol = 'admin' AND OLD.status = 'activo'
     AND (NEW.rol IS DISTINCT FROM 'admin' OR NEW.status IS DISTINCT FROM 'activo') THEN
    IF count_admins_activos(OLD.tenant_id) <= 1 THEN
      RAISE EXCEPTION
        'ULTIMO_ADMIN: no podés dejar el tenant sin ningún admin activo. Asigná otro admin primero.';
    END IF;
  END IF;

  -- #13 / I5 — integridad sucursal_id: universal (también para admin). NULL
  -- sigue permitido sin restricción (comportamiento existente, ON DELETE SET NULL).
  IF NEW.sucursal_id IS DISTINCT FROM OLD.sucursal_id AND NEW.sucursal_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM sucursales WHERE id = NEW.sucursal_id AND tenant_id = NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'SUCURSAL_TENANT_MISMATCH: esa sucursal no pertenece al gimnasio de este usuario';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_proteger_usuarios() IS
  'BEFORE UPDATE usuarios: C1 bloquea CUALQUIER cambio directo de un end-user no-admin (allowlist real, #13); C3 impide dejar el tenant sin admin activo; guard adicional impide asignar una sucursal de otro tenant (también para admin).';
-- El trigger usuarios_proteger_iam sigue apuntando a esta función (CREATE OR REPLACE), sin cambios de instalación.

-- #13 / I1 — eliminar el self-update directo. usuarios_update_admin NO se toca.
DROP POLICY IF EXISTS usuarios_update_self ON usuarios;

-- ════════════════════════════════════════════════════════════════════════════
-- Self-test determinista (mismo estilo que el repo). NO genera valores
-- arbitrarios para todas las columnas productivas — eso se valida
-- adversarialmente en sandbox con una columna sintética, documentado aparte.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _diag_usuarios_fail_closed()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_tenant_b uuid;
  v_auth uuid := gen_random_uuid(); v_auth_admin uuid := gen_random_uuid();
  v_socio uuid; v_admin uuid;
  v_slug text := 'zz-13-' || substr(md5(random()::text), 1, 6);
  v_slug_b text := 'zz-13b-' || substr(md5(random()::text), 1, 6);
  v_suc_propia uuid; v_suc_ajena uuid;
  v_ok boolean; v_n int;
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug, '#13 A', 'gym_libre', 'activo') RETURNING id INTO v_tenant;
  INSERT INTO tenants (slug, nombre, vertical, status) VALUES (v_slug_b, '#13 B', 'gym_libre', 'activo') RETURNING id INTO v_tenant_b;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_slug||'-s@x.dev',
          jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Socio'), '', now(), now(), now());
  SELECT id INTO v_socio FROM usuarios WHERE auth_id = v_auth;
  UPDATE usuarios SET status = 'activo' WHERE id = v_socio;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_slug||'-a@x.dev',
          jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'), '', now(), now(), now());
  UPDATE usuarios SET rol = 'admin', status = 'activo' WHERE auth_id = v_auth_admin RETURNING id INTO v_admin;

  INSERT INTO sucursales (tenant_id, nombre, timezone, activa, orden) VALUES (v_tenant, 'Sucursal propia', 'America/Mexico_City', true, 1) RETURNING id INTO v_suc_propia;
  INSERT INTO sucursales (tenant_id, nombre, timezone, activa, orden) VALUES (v_tenant_b, 'Sucursal ajena', 'America/Mexico_City', true, 1) RETURNING id INTO v_suc_ajena;

  -- T1 (self, vía rol de Postgres 'authenticated' simulando PostgREST): bloqueado.
  -- Al no existir ya usuarios_update_self, el bloqueo real ocurre por RLS (la
  -- fila no matchea ninguna policy de UPDATE para este rol → 0 filas afectadas,
  -- SIN excepción). El trigger trg_proteger_usuarios queda como segunda capa de
  -- defensa para un escenario donde RLS permitiera ver/tocar la fila.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE usuarios SET rol = 'admin' WHERE id = v_socio;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  prueba := 'T1a. miembro: UPDATE directo de rol → 0 filas (bloqueado por RLS, sin policy de self-update)';
  resultado := CASE WHEN v_n = 0 THEN '✅ ok' ELSE '❌ '||v_n||' filas afectadas' END; RETURN NEXT;

  UPDATE usuarios SET notas_admin = 'inyectado por el socio' WHERE id = v_socio;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  prueba := 'T1b. miembro: UPDATE directo de notas_admin → 0 filas (antes NO estaba bloqueado)';
  resultado := CASE WHEN v_n = 0 THEN '✅ ok' ELSE '❌ '||v_n||' filas afectadas' END; RETURN NEXT;

  UPDATE usuarios SET sucursal_id = v_suc_ajena WHERE id = v_socio;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  prueba := 'T1c. miembro: UPDATE directo de sucursal_id → 0 filas (antes NO estaba bloqueado)';
  resultado := CASE WHEN v_n = 0 THEN '✅ ok' ELSE '❌ '||v_n||' filas afectadas' END; RETURN NEXT;

  UPDATE usuarios SET stripe_customer_id = 'cus_inyectado' WHERE id = v_socio;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  prueba := 'T1d. miembro: UPDATE directo de stripe_customer_id → 0 filas (antes NO estaba bloqueado)';
  resultado := CASE WHEN v_n = 0 THEN '✅ ok' ELSE '❌ '||v_n||' filas afectadas' END; RETURN NEXT;

  UPDATE usuarios SET nombre = 'Intento de perfil directo' WHERE id = v_socio;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  prueba := 'T1e. miembro: UPDATE directo de un campo "inocuo" (nombre) → 0 filas (allowlist=0)';
  resultado := CASE WHEN v_n = 0 THEN '✅ ok' ELSE '❌ '||v_n||' filas afectadas' END; RETURN NEXT;

  RESET ROLE;
  -- Verificación corre YA fuera del rol authenticated: stripe_customer_id no está
  -- en el whitelist de columnas SELECT de ese rol en producción (REVOKE de
  -- 20260709160000) y esta query es diagnóstico interno, no una lectura de socio.
  SELECT count(*) INTO v_n FROM usuarios WHERE id = v_socio AND (rol <> 'miembro' OR notas_admin IS NOT NULL OR sucursal_id IS NOT NULL OR stripe_customer_id IS NOT NULL OR nombre = 'Intento de perfil directo');
  prueba := 'T1f. verificación: la fila del socio no cambió en NADA';
  resultado := CASE WHEN v_n = 0 THEN '✅ cero efecto persistido' ELSE '❌ '||v_n||' campos mutados' END; RETURN NEXT;

  -- T3: self-service legítimo (RPC) sigue funcionando tras quitar la policy.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM socio_actualizar_perfil('5555555555', NULL, NULL, NULL);
  RESET ROLE;
  SELECT (telefono = '5555555555') INTO v_ok FROM usuarios WHERE id = v_socio;
  prueba := 'T3. socio_actualizar_perfil sigue funcionando (RPC, sin la policy)';
  resultado := CASE WHEN v_ok THEN '✅ ok' ELSE '❌ telefono no se actualizó' END; RETURN NEXT;

  -- T4: admin sigue pudiendo escribir status/notas_admin/sucursal_id (propia).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_admin::text)::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE usuarios SET status = 'suspendido', notas_admin = 'nota de staff', sucursal_id = v_suc_propia WHERE id = v_socio;
  RESET ROLE;
  SELECT (status='suspendido' AND notas_admin='nota de staff' AND sucursal_id=v_suc_propia) INTO v_ok FROM usuarios WHERE id = v_socio;
  prueba := 'T4. admin: status + notas_admin + sucursal_id (propia) → sigue permitido';
  resultado := CASE WHEN v_ok THEN '✅ ok' ELSE '❌ no se aplicó' END; RETURN NEXT;

  -- T5: admin intenta sucursal de OTRO tenant → bloqueado; sucursal propia → éxito (ya cubierto en T4).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_admin::text)::text, true);
  SET LOCAL ROLE authenticated;
  v_ok := false;
  BEGIN
    UPDATE usuarios SET sucursal_id = v_suc_ajena WHERE id = v_socio;
  EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'SUCURSAL_TENANT_MISMATCH%';
  END;
  RESET ROLE;
  SELECT count(*) INTO v_n FROM usuarios WHERE id = v_socio AND sucursal_id = v_suc_propia;
  prueba := 'T5. admin: sucursal de OTRO tenant → SUCURSAL_TENANT_MISMATCH, cero cambio';
  resultado := CASE WHEN v_ok AND v_n = 1 THEN '✅ ok' ELSE '❌ bloqueo='||v_ok||' sucursal_sin_cambiar='||(v_n=1) END; RETURN NEXT;

  -- T7: último admin sigue protegido (admin intentando autodegradarse siendo el único activo).
  v_ok := false;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth_admin::text)::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE usuarios SET status = 'suspendido' WHERE id = v_admin;
  EXCEPTION WHEN raise_exception THEN v_ok := SQLERRM LIKE 'ULTIMO_ADMIN%';
  END;
  RESET ROLE;
  prueba := 'T7. último admin activo no puede autodegradarse (C3 preservado)';
  resultado := CASE WHEN v_ok THEN '✅ ok' ELSE '❌ no se bloqueó' END; RETURN NEXT;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
  PERFORM cerrar_tenant(v_slug_b);
  RETURN;
END $$;

SELECT * FROM _diag_usuarios_fail_closed();
DROP FUNCTION _diag_usuarios_fail_closed();
