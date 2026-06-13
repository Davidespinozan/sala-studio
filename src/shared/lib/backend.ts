import { supabase } from './supabase';
import { fetchWithTimeout } from './fetchWithTimeout';

const FUNCTIONS_BASE = '/.netlify/functions';

async function getAuthHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
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
