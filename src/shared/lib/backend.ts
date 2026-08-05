import { supabase } from './supabase';
import { fetchWithTimeout } from './fetchWithTimeout';

const FUNCTIONS_BASE = '/.netlify/functions';

async function getAuthHeader(): Promise<Record<string, string>> {
  let { data: { session } } = await supabase.auth.getSession();

  // En una PWA de escritorio que queda abierta/suspendida horas, el access_token
  // puede venir vencido (o a punto): getSession no siempre lo refresca a tiempo,
  // y mandar un token muerto = "Token inválido" en el backend. Si está por expirar,
  // forzamos un refresh para que la sesión se auto-cure sin que el usuario re-loguee.
  const margenSeg = 60;
  const ahoraSeg = Math.floor(Date.now() / 1000);
  if (session && (session.expires_at ?? 0) - ahoraSeg < margenSeg) {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data.session) session = data.session;
  }

  if (!session?.access_token) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}

export async function backendGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${FUNCTIONS_BASE}/${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const headers = await getAuthHeader();
  const res = await fetchWithTimeout(url.toString(), { headers });
  if (!res.ok) throw new Error(`backendGet ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function backendPost<T>(path: string, body?: unknown): Promise<T> {
  const headers = await getAuthHeader();
  const res = await fetchWithTimeout(`${FUNCTIONS_BASE}/${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
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
    const err = new Error(detail || `No se pudo completar la operación (${res.status}).`);
    (err as Error & { status?: number; path?: string }).status = res.status;
    (err as Error & { status?: number; path?: string }).path = path;
    throw err;
  }
  return res.json() as Promise<T>;
}
