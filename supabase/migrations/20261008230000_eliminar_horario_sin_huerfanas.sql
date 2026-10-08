-- ►► CORRER EN: proyecto Supabase de SALA-STUDIO — ref `omrlbvhbggnrwwzlgxji`
--
-- ── eliminar_horario_recurrente: borrar un horario ya no deja clases fantasma ──
-- Problema (numa, 8-oct): al eliminar un horario, la FK
-- clases.horario_recurrente_id (ON DELETE SET NULL) dejaba sus clases ya
-- guardadas (las editadas a mano: otro coach, otro cupo…) con horario NULL.
-- expandir_clases las trata como clases sueltas (rama 2) y seguían saliendo en
-- la Agenda y la app aunque el horario ya no existiera. Caso real: el sábado
-- 6am "no se podía quitar".
--
-- Cambio: el admin elimina por este RPC, que en UNA transacción:
--   1) bloquea el horario y TODAS sus clases (FOR UPDATE),
--   2) borra sus clases de HOY en adelante que no tengan NADA colgado
--      (ni reservas de ningún status, ni lista de espera, ni invitados),
--   3) borra el horario.
-- Las clases con reservas se conservan (las muestra la rama 3 de
-- expandir_clases): nunca se pierde una reserva. Las pasadas se conservan
-- (historial).
--
-- Por qué RPC y no dos llamadas desde el navegador: reservas.clase_id es
-- ON DELETE CASCADE. "Revisar que no haya reservas" y "borrar" por separado
-- deja una ventana donde una reserva recién hecha se borraría en cascada. Con
-- el FOR UPDATE, una reserva concurrente espera (su FK pide KEY SHARE sobre la
-- clase) y, si la clase se borró, falla con error en vez de perderse.
--
-- Aditivo. Reversible: DROP FUNCTION eliminar_horario_recurrente(uuid); el
-- frontend viejo (DELETE directo por RLS) sigue funcionando igual que antes.

CREATE OR REPLACE FUNCTION public.eliminar_horario_recurrente(p_horario_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_h RECORD;
  v_hoy date;
  v_borradas int;
  v_conservadas int;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo un administrador puede eliminar horarios';
  END IF;

  SELECT hr.id, hr.sucursal_id INTO v_h
  FROM horarios_recurrentes hr
  WHERE hr.id = p_horario_id AND hr.tenant_id = v_tenant
  FOR UPDATE;
  IF NOT FOUND THEN
    -- Mismo error si no existe o es de otro gym: no revela cuál.
    RAISE EXCEPTION 'HORARIO_NO_ENCONTRADO: el horario no existe';
  END IF;

  -- "Hoy" en la zona del gym (sede → gym → default), igual que expandir_clases.
  SELECT (now() AT TIME ZONE COALESCE(
            NULLIF(s.timezone, ''),
            (SELECT t.config->>'timezone' FROM tenants t WHERE t.id = v_tenant),
            'America/Mexico_City'))::date
    INTO v_hoy
  FROM sucursales s WHERE s.id = v_h.sucursal_id;
  v_hoy := COALESCE(v_hoy, (now() AT TIME ZONE 'America/Mexico_City')::date);

  PERFORM 1 FROM clases c
  WHERE c.horario_recurrente_id = p_horario_id
  ORDER BY c.id
  FOR UPDATE;

  DELETE FROM clases c
  WHERE c.horario_recurrente_id = p_horario_id
    AND c.fecha >= v_hoy
    AND NOT EXISTS (SELECT 1 FROM reservas r WHERE r.clase_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM lista_espera le WHERE le.clase_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM reserva_invitados ri WHERE ri.clase_id = c.id);
  GET DIAGNOSTICS v_borradas = ROW_COUNT;

  SELECT count(*) INTO v_conservadas
  FROM clases c
  WHERE c.horario_recurrente_id = p_horario_id AND c.fecha >= v_hoy;

  DELETE FROM horarios_recurrentes WHERE id = p_horario_id;

  RETURN jsonb_build_object(
    'ok', true,
    'clases_borradas', v_borradas,
    'clases_conservadas', v_conservadas
  );
END;
$$;

REVOKE ALL ON FUNCTION public.eliminar_horario_recurrente(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.eliminar_horario_recurrente(uuid) TO authenticated;
