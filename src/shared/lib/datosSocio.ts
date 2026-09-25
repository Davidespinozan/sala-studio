import { supabase } from '@shared/lib/supabase';

/**
 * Datos de la ficha del socio (tabla privada `usuarios_datos_privados`): sirven
 * para edad/cumpleaños y segmentar campañas. Se piden en el ALTA (admin y
 * recepción) — antes solo se podían cargar desde una ficha de admin escondida.
 * RLS: la escribe `is_recepcionista()` (recepción y admin), scopeada al tenant.
 */
export interface DatosPrivadosInput {
  fecha_nacimiento?: string | null; // 'YYYY-MM-DD'
  sexo?: string | null; // 'femenino' | 'masculino' | 'otro'
  domicilio?: string | null;
}

/** Upsert de los datos privados. No-op si vienen todos vacíos (no ensucia la tabla). */
export async function guardarDatosPrivados(
  usuarioId: string,
  tenantId: string,
  datos: DatosPrivadosInput
): Promise<{ error: string | null }> {
  const fecha_nacimiento = datos.fecha_nacimiento || null;
  const sexo = datos.sexo || null;
  const domicilio = datos.domicilio?.trim() || null;
  if (!fecha_nacimiento && !sexo && !domicilio) return { error: null };

  const { error } = await (supabase as any)
    .from('usuarios_datos_privados')
    .upsert(
      { usuario_id: usuarioId, tenant_id: tenantId, fecha_nacimiento, sexo, domicilio },
      { onConflict: 'usuario_id' }
    );
  return { error: error ? error.message : null };
}

/**
 * El SOCIO actualiza SU propio perfil (teléfono en `usuarios` + ficha privada) vía
 * el RPC `socio_actualizar_perfil` (SECURITY DEFINER). Se usa este RPC —y no el
 * upsert directo de `guardarDatosPrivados`— porque el socio no tiene permiso de
 * escritura sobre `usuarios_datos_privados` (solo SELECT).
 */
export async function actualizarPerfilSocio(datos: {
  telefono?: string | null;
  fecha_nacimiento?: string | null;
  sexo?: string | null;
  domicilio?: string | null;
}): Promise<{ error: string | null }> {
  const { error } = await (supabase.rpc as any)('socio_actualizar_perfil', {
    p_telefono: datos.telefono?.trim() || null,
    p_fecha_nacimiento: datos.fecha_nacimiento || null,
    p_sexo: datos.sexo || null,
    p_domicilio: datos.domicilio?.trim() || null
  });
  return { error: error ? error.message : null };
}

/**
 * ¿Le faltan al socio los datos obligatorios? Hoy: teléfono + fecha de nacimiento.
 * (sexo y domicilio son opcionales.) Decide el banner/aviso "Completa tu perfil".
 */
export function perfilIncompleto(datos: {
  telefono?: string | null;
  fecha_nacimiento?: string | null;
}): boolean {
  return !datos.telefono || !datos.fecha_nacimiento;
}

/**
 * Sube la foto del socio al bucket `avatars` y actualiza `usuarios.avatar_url`.
 * OJO: la RLS del bucket y de `usuarios` exige `is_admin()` — recepción NO puede
 * (por eso la foto solo se ofrece en el alta de admin). Mismo path que la ficha:
 * `<usuarioId>/<timestamp>.<ext>`.
 */
export async function subirAvatarSocio(
  usuarioId: string,
  file: File
): Promise<{ url: string | null; error: string | null }> {
  try {
    const ext = file.name.split('.').pop() || 'jpg';
    const path = `${usuarioId}/${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from('avatars')
      .upload(path, file, { cacheControl: '3600', upsert: false });
    if (upErr) throw upErr;
    const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);
    const { error: updErr } = await supabase
      .from('usuarios')
      .update({ avatar_url: publicUrl } as never)
      .eq('id', usuarioId);
    if (updErr) throw updErr;
    return { url: publicUrl, error: null };
  } catch (e) {
    return { url: null, error: e instanceof Error ? e.message : 'No se pudo subir la foto.' };
  }
}
