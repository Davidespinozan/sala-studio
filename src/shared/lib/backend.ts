import { supabase } from './supabase';
import { fetchWithTimeout } from './fetchWithTimeout';

const FUNCTIONS_BASE = '/.netlify/functions';

async function getAuthHeader(): Promise<Record<string, string>> {
  let { data: { session } } = await supabase.auth.getSession();

  // En una PWA de escritorio que queda abierta/suspendida horas, el access_token
  // puede venir vencido (o a punto): getSession no siempre lo refresca a tiempo,
  // y mandar un token muerto = "Token inválido" en el backend. Si está por expirar,
  // forzamos un refresh para que la sesión se auto-cure sin que el usuario re-loguee.
  const margenSeg = 120;
  const ahoraSeg = Math.floor(Date.now() / 1000);
  if (session && (session.expires_at ?? 0) - ahoraSeg < margenSeg) {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data.session) session = data.session;
  }

  if (!session?.access_token) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * Fuerza un refresh y devuelve el header con el token nuevo (o vacío si el refresh
 * falló, ej. el refresh_token también venció). Se usa para REINTENTAR cuando el
 * backend respondió 401: el refresh proactivo puede no alcanzar si el token venció
 * justo, o si getSession devolvió uno viejo — reintentar con uno fresco lo cura.
 */
async function refrescarHeader(): Promise<Record<string, string>> {
  const { data, error } = await supabase.auth.refreshSession();
  if (!error && data.session?.access_token) {
    return { Authorization: `Bearer ${data.session.access_token}` };
  }
  return {};
}

export async function backendGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${FUNCTIONS_BASE}/${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  let res = await fetchWithTimeout(url.toString(), { headers: await getAuthHeader() });
  if (res.status === 401) {
    const fresh = await refrescarHeader();
    if (fresh.Authorization) res = await fetchWithTimeout(url.toString(), { headers: fresh });
  }
  if (!res.ok) throw new Error(`backendGet ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function backendPost<T>(path: string, body?: unknown): Promise<T> {
  const enviar = (headers: Record<string, string>) =>
    fetchWithTimeout(`${FUNCTIONS_BASE}/${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });

  let res = await enviar(await getAuthHeader());

  // 401 = token muerto (sesión suspendida, o venció entre el check y el envío).
  // Forzamos refresh y reintentamos UNA vez antes de rendirnos: así el registro/
  // acción se auto-cura sin el críptico "Token inválido" ni pedir re-login.
  if (res.status === 401) {
    const fresh = await refrescarHeader();
    if (fresh.Authorization) res = await enviar(fresh);
  }

  if (!res.ok) {
    // Motivo humano del body (la function devuelve { error: '…' }) como mensaje
    // del Error → las UIs lo muestran directo, sin prefijo técnico. status/path
    // quedan como props para diagnóstico.
    let detail = '';
    try {
      const text = await res.text();
      if (text) {
        try {
          const json = JSON.parse(text);
          detail = json?.error || json?.message || text;
        } catch {
          detail = text;
        }
      }
    } catch {
      // sin body legible → ignorar
    }
    // Si tras el reintento sigue 401, la sesión de verdad expiró → mensaje claro.
    if (res.status === 401) {
      const err = new Error('Tu sesión expiró. Cierra sesión y vuelve a entrar.');
      (err as Error & { status?: number; path?: string }).status = 401;
      (err as Error & { status?: number; path?: string }).path = path;
      throw err;
    }
    const err = new Error(detail || `No se pudo completar la operación (${res.status}).`);
    (err as Error & { status?: number; path?: string }).status = res.status;
    (err as Error & { status?: number; path?: string }).path = path;
    throw err;
  }
  return res.json() as Promise<T>;
}