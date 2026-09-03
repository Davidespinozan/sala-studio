-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref omrlbvhbggnrwwzlgxji
-- ============================================================================
-- Corregir el MÉTODO de un pago (efectivo↔tarjeta↔transferencia) sin mover dinero
-- ----------------------------------------------------------------------------
-- Caso (numa): registraron la venta de un plan como EFECTIVO cuando en realidad fue
-- TERMINAL (tarjeta). Intentaron editarlo y no pudieron: `pagos` es append-only (el
-- trigger bloquea todo UPDATE/DELETE). Pero corregir el MÉTODO no mueve dinero —el
-- monto ya entró, solo estaba mal clasificado— así que el corte debe reflejar cómo
-- entró de verdad.
--
-- Solución: un RPC de staff que cambia SOLO el método (y anexa una nota de auditoría),
-- y el trigger append-only lo permite EXCLUSIVAMENTE cuando: (a) lo dispara este RPC
-- (flag sala.corrige_metodo) y (b) todo lo demás del pago queda idéntico (monto,
-- concepto, socio, tier, membresía, sede, cobrador, fecha, reversa). Cualquier otro
-- UPDATE/DELETE sigue bloqueado. No aplica a 'stripe' (cobro online real) ni
-- 'cortesia' (no es dinero): esos no se reclasifican a mano.
--
-- OJO con el corte: `cortes_caja.resumen` es una FOTO que se calcula al CERRAR el
-- corte. Si el corte del periodo aún NO se cerró, corregir el pago arregla el corte
-- solo. Si ya se cerró, esa foto no cambia (habría que revisar ese corte aparte).
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_pagos_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- DELETE: solo dentro de cerrar_tenant() (que prende sala.cierre_tenant).
  IF TG_OP = 'DELETE'
     AND current_setting('sala.cierre_tenant', true) = 'on' THEN
    RETURN OLD;
  END IF;

  -- UPDATE: solo para CORREGIR EL MÉTODO (no mueve dinero), dentro de
  -- corregir_metodo_pago() (que prende sala.corrige_metodo). Todo lo demás del
  -- pago debe quedar idéntico; solo pueden cambiar `metodo` y `notas`.
  IF TG_OP = 'UPDATE'
     AND current_setting('sala.corrige_metodo', true) = 'on'
     AND NEW.metodo IN ('efectivo', 'tarjeta', 'transferencia')
     AND NEW.monto_centavos   IS NOT DISTINCT FROM OLD.monto_centavos
     AND NEW.moneda           IS NOT DISTINCT FROM OLD.moneda
     AND NEW.concepto         IS NOT DISTINCT FROM OLD.concepto
     AND NEW.usuario_id       IS NOT DISTINCT FROM OLD.usuario_id
     AND NEW.tenant_id        IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.tier_id          IS NOT DISTINCT FROM OLD.tier_id
     AND NEW.membresia_id     IS NOT DISTINCT FROM OLD.membresia_id
     AND NEW.sucursal_id      IS NOT DISTINCT FROM OLD.sucursal_id
     AND NEW.cobrado_por      IS NOT DISTINCT FROM OLD.cobrado_por
     AND NEW.created_at       IS NOT DISTINCT FROM OLD.created_at
     AND NEW.revierte_pago_id IS NOT DISTINCT FROM OLD.revierte_pago_id
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'PAGOS_APPEND_ONLY: un pago no se edita ni se borra; registrá un asiento de corrección';
END;
$$;

COMMENT ON FUNCTION trg_pagos_append_only() IS
  'Append-only de pagos. UPDATE/DELETE bloqueados, salvo: (1) DELETE dentro de '
  'cerrar_tenant() (flag sala.cierre_tenant); (2) UPDATE de SOLO metodo/notas dentro '
  'de corregir_metodo_pago() (flag sala.corrige_metodo), con el resto del pago idéntico.';


CREATE OR REPLACE FUNCTION corregir_metodo_pago(
  p_pago_id uuid,
  p_metodo text,
  p_motivo text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
  v_old text;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo staff (admin/recepción) puede corregir el método de un pago';
  END IF;

  IF p_metodo NOT IN ('efectivo', 'tarjeta', 'transferencia') THEN
    RAISE EXCEPTION 'METODO_INVALIDO: método no válido (%); usa efectivo, tarjeta o transferencia', p_metodo;
  END IF;

  v_tenant := get_my_tenant_id();

  SELECT metodo INTO v_old FROM pagos WHERE id = p_pago_id AND tenant_id = v_tenant;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'PAGO_NO_EXISTE: ese pago no existe en tu gimnasio';
  END IF;

  -- Solo se reclasifica entre métodos de dinero de mostrador.
  IF v_old NOT IN ('efectivo', 'tarjeta', 'transferencia') THEN
    RAISE EXCEPTION 'METODO_NO_CORREGIBLE: este pago es % y no se reclasifica a mano', v_old;
  END IF;

  IF v_old = p_metodo THEN
    RETURN;  -- ya está en ese método
  END IF;

  PERFORM set_config('sala.corrige_metodo', 'on', true);

  UPDATE pagos
  SET metodo = p_metodo,
      notas = CASE WHEN COALESCE(trim(notas), '') = '' THEN '' ELSE trim(notas) || ' · ' END
              || format('[método corregido %s→%s%s]', v_old, p_metodo,
                        CASE WHEN NULLIF(trim(p_motivo), '') IS NOT NULL
                             THEN ': ' || trim(p_motivo) ELSE '' END)
  WHERE id = p_pago_id AND tenant_id = v_tenant;

  PERFORM set_config('sala.corrige_metodo', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION corregir_metodo_pago(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION corregir_metodo_pago(uuid, text, text) TO authenticated;


-- ============================================================================
-- SELF-TEST — DEVUELVE TABLA.
--   1) corregir_metodo_pago efectivo→tarjeta → el pago queda en 'tarjeta'.
--   2) UPDATE directo del método SIN el flag → sigue bloqueado (append-only).
--   3) Con el flag prendido, intentar cambiar el MONTO → bloqueado (solo método/notas).
-- ============================================================================
CREATE OR REPLACE FUNCTION _diag_corregir_metodo_pago()
RETURNS TABLE(prueba text, resultado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_auth uuid := gen_random_uuid(); v_admin uuid; v_socio uuid;
  v_pago uuid; v_metodo text; v_r text;
  v_slug text := 'zz-test-cmp-' || substr(md5(random()::text), 1, 6);
BEGIN
  INSERT INTO tenants (slug, nombre, vertical, status)
  VALUES (v_slug, 'Test corregir método', 'gym_libre', 'activo') RETURNING id INTO v_tenant;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data,
                          encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES (v_auth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          v_slug || '-admin@sala.dev', jsonb_build_object('tenant_slug', v_slug, 'nombre', 'Admin'),
          '', now(), now(), now());
  UPDATE usuarios SET rol = 'admin', status = 'activo' WHERE auth_id = v_auth RETURNING id INTO v_admin;

  INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
  VALUES (v_tenant, v_slug||'-s@x.dev', 'Socio', 'miembro', 'activo') RETURNING id INTO v_socio;

  -- Pago directo (el trigger append-only solo bloquea UPDATE/DELETE, no INSERT).
  INSERT INTO pagos (tenant_id, usuario_id, concepto, monto_centavos, moneda, metodo, notas, cobrado_por)
  VALUES (v_tenant, v_socio, 'plan', 80000, 'MXN', 'efectivo', 'venta plan', v_admin)
  RETURNING id INTO v_pago;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth::text)::text, true);

  -- 1) Corregir efectivo→tarjeta.
  PERFORM corregir_metodo_pago(v_pago, 'tarjeta', 'era terminal');
  SELECT metodo INTO v_metodo FROM pagos WHERE id = v_pago;
  prueba := '1. corregir efectivo→tarjeta';
  resultado := CASE WHEN v_metodo = 'tarjeta' THEN '✅ quedó en tarjeta' ELSE '❌ quedó en ' || COALESCE(v_metodo,'NULL') END;
  RETURN NEXT;

  -- 2) UPDATE directo del método SIN flag → bloqueado.
  prueba := '2. UPDATE directo sin flag → bloqueado';
  BEGIN
    UPDATE pagos SET metodo = 'transferencia' WHERE id = v_pago;
    resultado := '❌ dejó editar sin control';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_r = MESSAGE_TEXT;
    resultado := CASE WHEN v_r LIKE 'PAGOS_APPEND_ONLY%' THEN '✅ bloqueó' ELSE '⚠ otro: ' || v_r END;
  END;
  RETURN NEXT;

  -- 3) Con flag on, cambiar el MONTO → bloqueado (solo método/notas permitido).
  prueba := '3. con flag, cambiar monto → bloqueado';
  BEGIN
    PERFORM set_config('sala.corrige_metodo', 'on', true);
    UPDATE pagos SET monto_centavos = 999999 WHERE id = v_pago;
    PERFORM set_config('sala.corrige_metodo', 'off', true);
    resultado := '❌ dejó cambiar el monto';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_r = MESSAGE_TEXT;
    resultado := CASE WHEN v_r LIKE 'PAGOS_APPEND_ONLY%' THEN '✅ bloqueó (dinero intocable)' ELSE '⚠ otro: ' || v_r END;
  END;
  RETURN NEXT;

  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM cerrar_tenant(v_slug);
  RETURN;
END $$;

SELECT * FROM _diag_corregir_metodo_pago();
DROP FUNCTION _diag_corregir_metodo_pago();
