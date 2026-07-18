-- ============================================================================
-- Onboarding: detectar TEMPRANO que el email ya tiene cuenta.
-- ----------------------------------------------------------------------------
-- PROBLEMA (el del "vuelo de avión"): alguien empieza el alta, llega al paso del
-- pago, no pone la tarjeta y se va. Cuando vuelve e intenta de nuevo con el
-- mismo email, llena TODO el wizard otra vez y recién al final el backend le
-- dice "Ya existe una cuenta con ese email". Peor: el front intenta loguearlo
-- con la contraseña que acaba de escribir (que puede no ser la original), falla,
-- y termina en una pantalla de "listo" con el subdominio VIEJO, sin estar
-- logueado y sin haber puesto nunca la tarjeta. Un callejón sin salida — y es
-- justo el cliente más fácil de recuperar, el que se arrepintió y volvió.
--
-- Con esto el wizard lo detecta en el PRIMER paso y le ofrece iniciar sesión
-- para seguir donde quedó, en vez de hacerle perder el tiempo.
--
-- SOBRE ENUMERACIÓN DE EMAILS: sí, esto confirma si un email está registrado.
-- No agrega ninguna información nueva: el endpoint de alta YA la revela con el
-- mensaje "Ya existe una cuenta con ese email". El costo es cero y el beneficio
-- de UX es directo.
--
-- Mira las DOS tablas: Supabase guarda el email en `auth.users` y otra copia en
-- `auth.identities.identity_data->>'email'`. Mirar solo una da falsos negativos
-- (ya nos pasó liberando emails a mano).
-- ============================================================================

CREATE OR REPLACE FUNCTION email_tiene_cuenta(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users
    WHERE lower(email) = lower(trim(p_email))
  ) OR EXISTS (
    SELECT 1 FROM auth.identities
    WHERE provider = 'email'
      AND lower(identity_data->>'email') = lower(trim(p_email))
  );
$$;

REVOKE ALL ON FUNCTION email_tiene_cuenta(text) FROM PUBLIC;
-- Público: el onboarding es pre-auth (anon).
GRANT EXECUTE ON FUNCTION email_tiene_cuenta(text) TO anon, authenticated;

COMMENT ON FUNCTION email_tiene_cuenta(text) IS
  'Onboarding: true si el email ya tiene cuenta (mira auth.users Y auth.identities). Para avisar en el paso 1 en vez de rechazar al final. Ver 20260718140000.';

-- ============================================================================
-- TEST — devuelve TABLA (el editor esconde los NOTICE).
-- ============================================================================
DROP TABLE IF EXISTS _res_email;
DO $$
DECLARE
  v_real   text;
  v_falso  text := 'zz-no-existe-' || substr(md5(random()::text), 1, 10) || '@sala.invalid';
BEGIN
  CREATE TEMP TABLE _res_email(caso text, esperado text, obtenido text, ok boolean) ON COMMIT PRESERVE ROWS;

  SELECT email INTO v_real FROM auth.users WHERE email IS NOT NULL LIMIT 1;

  IF v_real IS NULL THEN
    INSERT INTO _res_email VALUES ('sin usuarios para probar', '-', '-', true);
  ELSE
    INSERT INTO _res_email VALUES
      ('1 email existente se detecta', 'true', email_tiene_cuenta(v_real)::text, email_tiene_cuenta(v_real) = true);
    INSERT INTO _res_email VALUES
      ('2 con MAYUSCULAS igual lo detecta', 'true', email_tiene_cuenta(upper(v_real))::text, email_tiene_cuenta(upper(v_real)) = true);
    INSERT INTO _res_email VALUES
      ('3 con espacios igual lo detecta', 'true', email_tiene_cuenta('  ' || v_real || '  ')::text, email_tiene_cuenta('  ' || v_real || '  ') = true);
  END IF;

  INSERT INTO _res_email VALUES
    ('4 email inventado da libre', 'false', email_tiene_cuenta(v_falso)::text, email_tiene_cuenta(v_falso) = false);
END $$;

SELECT caso, esperado, obtenido, CASE WHEN ok THEN 'OK' ELSE '*** FALLO ***' END AS resultado
FROM _res_email ORDER BY caso;