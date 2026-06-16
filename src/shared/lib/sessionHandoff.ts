import { supabase } from '@shared/lib/supabase';

/**
 * Hand-off de sesión entre orígenes del mismo producto (apex → subdominio del
 * tenant). La sesión vive en localStorage POR ORIGEN (elegido por la PWA iOS),
 * así que no se comparte entre salastudio.app y mi-gym.salastudio.app. Cuando un
 * usuario hace login en el apex y es de otro gym, pasamos su sesión al subdominio
 * por el fragmento de la URL (#...), que NO viaja al servidor — el mismo
 * mecanismo que usan los magic links de Supabase. El destino la aplica y limpia
 * el fragmento de inmediato, así no queda en la barra ni en el historial visible.
 */
const HANDOFF_AT = 'sb_at';
const HANDOFF_RT = 'sb_rt';

/** URL del subdominio destino con la sesión en el fragmento. */
export function buildHandoffUrl(
  slug: string,
  domain: string,
  accessToken: string,
  refreshToken: string,
  path = '/'
): string {
  const frag = `${HANDOFF_AT}=${encodeURIComponent(accessToken)}&${HANDOFF_RT}=${encodeURIComponent(refreshToken)}`;
  return `https://${slug}.${domain}${path}#${frag}`;
}

/**
 * Si la URL trae una sesión por hand-off, la aplica (setSession) y limpia el
 * fragmento. Devuelve true si consumió un hand-off válido. Llamar ANTES de
 * getSession en el bootstrap de auth.
 */
export async function consumeSessionHandoff(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const hash = window.location.hash;
  if (!hash || !hash.includes(`${HANDOFF_AT}=`)) return false;

  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const accessToken = params.get(HANDOFF_AT);
  const refreshToken = params.get(HANDOFF_RT);

  // Limpiar el fragmento SIEMPRE (no dejar tokens visibles), pase lo que pase.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);

  if (!accessToken || !refreshToken) return false;
  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken
  });
  return !error;
}
