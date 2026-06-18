-- ============================================================================
-- Mapa de Salón: el socio debe VER qué lugares están ocupados
-- ----------------------------------------------------------------------------
-- Bug: al elegir lugar, la RLS `reservas_read_self` solo deja que el socio vea
-- SUS propias reservas → el selector mostraba TODOS los lugares como libres
-- aunque la clase estuviera casi llena (no podía saber cuáles tomaron otros).
--
-- Fix: un RPC SECURITY DEFINER que devuelve solo los `lugar_id` ocupados de la
-- clase (números de lugar, confirmada/completada) SIN exponer quién los tiene.
-- Acotado al tenant del que llama, para no filtrar entre gimnasios.
-- ============================================================================

CREATE OR REPLACE FUNCTION lugares_ocupados(p_clase_id uuid)
RETURNS TABLE (lugar_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.lugar_id
  FROM reservas r
  JOIN clases c ON c.id = r.clase_id
  WHERE r.clase_id = p_clase_id
    AND r.status IN ('confirmada', 'completada')
    AND r.lugar_id IS NOT NULL
    -- Solo si el que llama pertenece al mismo tenant que la clase (no filtra
    -- lugares de otro gimnasio aunque adivinen el UUID de la clase).
    AND c.tenant_id = (SELECT u.tenant_id FROM usuarios u WHERE u.auth_id = auth.uid());
$$;

GRANT EXECUTE ON FUNCTION lugares_ocupados(uuid) TO authenticated;

COMMENT ON FUNCTION lugares_ocupados(uuid) IS
  'Mapa de Salón: lugar_id ocupados de una clase (confirmada/completada), sin exponer identidad. SECURITY DEFINER para sortear reservas_read_self; acotado al tenant del que llama.';
