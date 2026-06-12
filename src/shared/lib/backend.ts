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
    // Incluir el motivo real del body (la function devuelve { error: '…' }) en
    // vez de solo el status, para no diagnosticar a ciegas.
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
    throw new Error(
      detail
        ? `backendPost ${path}: ${res.status} — ${detail}`
        : `backendPost ${path}: ${res.status}`
    );
  }
  return res.json() as Promise<T>;
}
