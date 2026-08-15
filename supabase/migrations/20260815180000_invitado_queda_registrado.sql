-- ════════════════════════════════════════════════════════════════════════════
-- Proyecto Supabase: SALA — omrlbvhbggnrwwzlgxji
-- El INVITADO queda REGISTRADO como socio al agregarlo (no un paso aparte).
-- ────────────────────────────────────────────────────────────────────────────
-- Antes: agregar un invitado solo guardaba nombre/tel/email en reserva_invitados
-- (un prospecto suelto, sin cuenta). numa terminaba registrándolo a mano aparte.
-- Ahora: al agregar el invitado (nombre + teléfono o email), el sistema crea su
-- ficha de socio automáticamente (o la liga si ya existe uno con ese contacto).
-- Así aparece en Socios (con etiqueta "Invitado" = socio sin plan que llegó como
-- invitado) y recepción no lo captura dos veces.
--
--   • reserva_invitados.usuario_id → liga el invitado a su ficha de socio.
--   • recepcion_agregar_invitado(reserva, nombre, tel, email) → busca-o-crea el
--     socio y registra el invitado ligado. Sin email real → marcador
--     '…@sin-correo.local' (mismo patrón que importar_miembros).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE reserva_invitados
  ADD COLUMN IF NOT EXISTS usuario_id uuid REFERENCES usuarios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS reserva_invitados_usuario_idx
  ON reserva_invitados (usuario_id) WHERE usuario_id IS NOT NULL;

COMMENT ON COLUMN reserva_invitados.usuario_id IS
  'Ficha de socio del invitado (se crea/liga al agregarlo). NULL solo para invitados viejos previos a esta migración.';

-- ── RPC: agregar invitado → queda registrado como socio ──────────────────────
CREATE OR REPLACE FUNCTION recepcion_agregar_invitado(
  p_reserva_id uuid,
  p_nombre text,
  p_telefono text DEFAULT NULL,
  p_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_reserva reservas;
  v_nombre text := trim(COALESCE(p_nombre, ''));
  v_tel text := NULLIF(trim(COALESCE(p_telefono, '')), '');
  v_email text := NULLIF(lower(trim(COALESCE(p_email, ''))), '');
  v_socio uuid;
  v_creado boolean := false;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: Solo recepción o admin pueden agregar invitados';
  END IF;
  IF v_nombre = '' THEN
    RAISE EXCEPTION 'NOMBRE_REQUERIDO: El invitado necesita un nombre';
  END IF;
  IF v_tel IS NULL AND v_email IS NULL THEN
    RAISE EXCEPTION 'CONTACTO_REQUERIDO: El invitado necesita teléfono o email';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id AND tenant_id = v_tenant;
  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_EXISTE: Esa reserva no existe en tu gimnasio';
  END IF;

  -- ¿Ya existe un socio con ese email o teléfono? → ligar, no duplicar.
  SELECT id INTO v_socio
  FROM usuarios
  WHERE tenant_id = v_tenant AND rol = 'miembro'
    AND (
      (v_email IS NOT NULL AND lower(email) = v_email)
      OR (v_tel IS NOT NULL AND telefono = v_tel)
    )
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_socio IS NULL THEN
    INSERT INTO usuarios (tenant_id, nombre, email, telefono, rol, status, notas_admin)
    VALUES (
      v_tenant, v_nombre,
      COALESCE(v_email, 'invitado-' || gen_random_uuid() || '@sin-correo.local'),
      v_tel, 'miembro', 'activo',
      'Llegó como invitado el ' || to_char(now(), 'DD/MM/YYYY') || '. Sin plan todavía.'
    )
    RETURNING id INTO v_socio;
    v_creado := true;
  END IF;

  INSERT INTO reserva_invitados (tenant_id, reserva_id, nombre, telefono, email, usuario_id)
  VALUES (v_tenant, p_reserva_id, v_nombre, v_tel, v_email, v_socio);

  RETURN jsonb_build_object('success', true, 'usuario_id', v_socio, 'creado', v_creado);
END;
$$;

REVOKE ALL ON FUNCTION recepcion_agregar_invitado(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION recepcion_agregar_invitado(uuid, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION recepcion_agregar_invitado(uuid, text, text, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- TEST — devuelve TABLA: la columna y el RPC existen, y el RPC exige contacto.
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  'invitado queda registrado' AS prueba,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'reserva_invitados' AND column_name = 'usuario_id')          AS columna_usuario_id,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'recepcion_agregar_invitado')             AS rpc_existe,
  pg_get_functiondef('recepcion_agregar_invitado(uuid, text, text, text)'::regprocedure)
    ILIKE '%CONTACTO_REQUERIDO%'                                                          AS exige_contacto;
