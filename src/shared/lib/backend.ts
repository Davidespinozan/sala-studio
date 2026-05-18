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
  if (!res.ok) throw new Error(`backendPost ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}
