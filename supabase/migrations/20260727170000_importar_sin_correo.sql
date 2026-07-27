-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- IMPORTAR MIEMBROS SIN CORREO — socios que no tienen email (ya pagaron).
-- ────────────────────────────────────────────────────────────────────────────
-- Sistemas viejos (SIAGYM) ponen un correo de relleno (default@siagym.com) a los
-- socios que no tienen email. No hay que guardar ese correo falso, pero el socio
-- SÍ debe entrar (ya pagó su membresía). Como usuarios.email es NOT NULL + UNIQUE,
-- se le pone un MARCADOR interno único (@sin-correo.local) y una nota para
-- recepción. Cuando el socio vaya al local, recepción le pone su correo real en la
-- ficha y ahí activa su cuenta.
--
-- Cambios vs la versión anterior de importar_miembros:
--   · email vacío → ya no es error; genera el marcador + nota "sin correo".
--   · dedup: con correo real, por email; sin correo, por teléfono (si hay), para
--     que re-importar no duplique.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION importar_miembros(
  p_tenant_id uuid,
  p_rows jsonb   -- [{ nombre, email, telefono, tier_id, vencimiento, creditos }]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row jsonb;
  v_nombre text;
  v_email text;
  v_tel text;
  v_sin_correo boolean;
  v_tier tiers;
  v_venc timestamptz;
  v_creditos integer;
  v_usuario_id uuid;
  v_membresia_id uuid;
  v_existe uuid;
  v_creados int := 0;
  v_omitidos int := 0;
  v_errores int := 0;
  v_detalle jsonb := '[]'::jsonb;
BEGIN
  IF p_tenant_id IS NULL THEN RAISE EXCEPTION 'TENANT_NULL'; END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    BEGIN
      v_nombre := NULLIF(btrim(v_row->>'nombre'), '');
      v_email  := NULLIF(lower(btrim(v_row->>'email')), '');
      v_tel    := NULLIF(btrim(v_row->>'telefono'), '');
      v_sin_correo := false;

      IF v_nombre IS NULL THEN
        v_errores := v_errores + 1;
        v_detalle := v_detalle || jsonb_build_object('email', v_row->>'email', 'nombre', v_row->>'nombre', 'resultado', 'error', 'motivo', 'Falta el nombre');
        CONTINUE;
      END IF;

      -- Sin correo real → marcador único + se marca para la nota. El socio entra
      -- activo; recepción le pone su email de verdad después.
      IF v_email IS NULL THEN
        v_email := 'sincorreo-' || replace(gen_random_uuid()::text, '-', '') || '@sin-correo.local';
        v_sin_correo := true;
      END IF;

      SELECT * INTO v_tier FROM tiers WHERE id = NULLIF(v_row->>'tier_id','')::uuid;
      IF v_tier.id IS NULL OR v_tier.tenant_id <> p_tenant_id THEN
        v_errores := v_errores + 1;
        v_detalle := v_detalle || jsonb_build_object('email', v_row->>'email', 'nombre', v_nombre, 'resultado', 'error', 'motivo', 'Plan inválido');
        CONTINUE;
      END IF;

      -- Dedup: con correo real → por email. Sin correo → por teléfono (si hay),
      -- para que re-importar no duplique al mismo.
      IF v_sin_correo THEN
        IF v_tel IS NOT NULL THEN
          SELECT id INTO v_existe FROM usuarios
          WHERE tenant_id = p_tenant_id AND telefono = v_tel LIMIT 1;
        ELSE
          v_existe := NULL;
        END IF;
      ELSE
        SELECT id INTO v_existe FROM usuarios
        WHERE tenant_id = p_tenant_id AND lower(email) = v_email LIMIT 1;
      END IF;
      IF v_existe IS NOT NULL THEN
        v_omitidos := v_omitidos + 1;
        v_detalle := v_detalle || jsonb_build_object('email', v_row->>'email', 'nombre', v_nombre, 'resultado', 'omitido', 'motivo', 'Ya existe en tu gimnasio');
        CONTINUE;
      END IF;

      v_venc := NULLIF(v_row->>'vencimiento','')::timestamptz;
      IF v_venc IS NULL THEN
        v_venc := now() + CASE WHEN v_tier.periodo = 'anual' THEN interval '1 year' ELSE interval '1 month' END;
      END IF;
      v_creditos := NULLIF(v_row->>'creditos','')::integer;

      INSERT INTO usuarios (tenant_id, nombre, email, telefono, rol, status, membresia_tier, notas_admin)
      VALUES (
        p_tenant_id, v_nombre, v_email, v_tel, 'miembro', 'activo', v_tier.slug,
        CASE WHEN v_sin_correo
          THEN 'Importado SIN correo. Pídele su email y actualízalo en la ficha para que pueda activar su cuenta.'
          ELSE NULL END
      )
      RETURNING id INTO v_usuario_id;

      INSERT INTO membresias (
        tenant_id, usuario_id, tier_id, status,
        periodo_actual_inicio, periodo_actual_fin, creditos_restantes
      )
      VALUES (
        p_tenant_id, v_usuario_id, v_tier.id, 'activa',
        now(), v_venc,
        CASE WHEN v_tier.tipo IN ('creditos','hibrido') THEN COALESCE(v_creditos, 0) ELSE NULL END
      )
      RETURNING id INTO v_membresia_id;

      UPDATE usuarios SET membresia_activa_id = v_membresia_id WHERE id = v_usuario_id;

      IF v_tier.tipo IN ('creditos','hibrido') AND COALESCE(v_creditos,0) > 0 THEN
        INSERT INTO membresia_movimientos (membresia_id, tenant_id, tipo, delta_creditos, motivo)
        VALUES (v_membresia_id, p_tenant_id, 'alta', v_creditos, 'Importación');
      END IF;

      v_creados := v_creados + 1;
      v_detalle := v_detalle || jsonb_build_object(
        'email', CASE WHEN v_sin_correo THEN NULL ELSE v_email END,
        'nombre', v_nombre, 'resultado', 'creado',
        'motivo', CASE WHEN v_sin_correo THEN 'sin correo' ELSE NULL END
      );

    EXCEPTION WHEN OTHERS THEN
      v_errores := v_errores + 1;
      v_detalle := v_detalle || jsonb_build_object('email', v_row->>'email', 'nombre', v_nombre, 'resultado', 'error', 'motivo', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'creados', v_creados, 'omitidos', v_omitidos, 'errores', v_errores, 'detalle', v_detalle
  );
END; $$;

REVOKE ALL ON FUNCTION importar_miembros(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — se auto-verifica (aborta si un socio sin correo NO entra) y revierte.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tenant uuid; v_tier uuid; v_res jsonb;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE status = 'activo' ORDER BY created_at LIMIT 1;
  IF v_tenant IS NULL THEN RAISE NOTICE 'TEST SKIP: sin tenant.'; RETURN; END IF;

  INSERT INTO tiers (tenant_id, slug, nombre, tipo, precio_centavos, moneda, duracion_dias, activo, orden)
  VALUES (v_tenant, 'sincorreo-test', 'SinCorreo Test', 'tiempo', 100000, 'MXN', 30, true, 999)
  RETURNING id INTO v_tier;

  v_res := importar_miembros(v_tenant, jsonb_build_array(
    jsonb_build_object('nombre','Sin Correo','email','','telefono','6670000000','tier_id',v_tier::text,'vencimiento','2026-12-31','creditos','')
  ));

  IF (v_res->>'creados')::int <> 1 THEN
    RAISE EXCEPTION 'TEST FALLO: el socio sin correo no se creó (%).', v_res::text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM usuarios
    WHERE tenant_id = v_tenant AND telefono = '6670000000' AND email LIKE '%@sin-correo.local'
  ) THEN
    RAISE EXCEPTION 'TEST FALLO: no quedó con el marcador @sin-correo.local.';
  END IF;

  RAISE EXCEPTION 'ROLLBACK_OK_SINCORREO';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'TEST FALLO%' THEN RAISE;
  ELSIF SQLERRM = 'ROLLBACK_OK_SINCORREO' THEN NULL;
  ELSE RAISE;
  END IF;
END $$;

SELECT 'importar_miembros acepta sin correo (marcador @sin-correo.local)' AS prueba, true AS ok;
