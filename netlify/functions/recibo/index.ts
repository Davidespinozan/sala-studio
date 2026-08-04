import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, notFound, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /recibo — PÚBLICO. Devuelve los datos del recibo de un pago si el token
 * firmado coincide. Lo consume tanto la app (ReciboModal) como la página pública
 * /recibo (a la que llega el socio por el link de WhatsApp, sin sesión).
 *
 * Body: { id, t }. El token es HMAC(id) con el service_role: sin él no se puede
 * leer el recibo (los ids no son adivinables + el token lo blinda).
 */

async function tokenValido(id: string, t: string, secret: string): Promise<boolean> {
  const { createHmac, timingSafeEqual } = await import('node:crypto');
  const esperado = createHmac('sha256', secret).update(id).digest('base64url').slice(0, 24);
  const a = Buffer.from(t);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

function pick<T = unknown>(obj: unknown, ...path: string[]): T | null {
  let cur: any = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[k];
  }
  return (cur ?? null) as T | null;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const { id, t } = JSON.parse(event.body || '{}') as { id?: string; t?: string };
    if (!id || !t) return badRequest('Falta el recibo');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    if (!(await tokenValido(id, t, serviceKey))) return notFound('Recibo no encontrado');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: pago } = await admin
      .from('pagos')
      .select('id, created_at, concepto, monto_centavos, moneda, metodo, tenant_id, tier:tiers(nombre), socio:usuarios!pagos_usuario_id_fkey(nombre)')
      .eq('id', id)
      .maybeSingle();
    if (!pago) return notFound('Recibo no encontrado');

    const p = pago as any;

    const { data: tenant } = await admin
      .from('tenants')
      .select('nombre, branding, config')
      .eq('id', p.tenant_id)
      .maybeSingle();

    const branding = (tenant?.branding ?? {}) as Record<string, unknown>;
    const config = (tenant?.config ?? {}) as Record<string, unknown>;

    const logoUrl =
      (typeof branding.logo_url === 'string' && branding.logo_url) ||
      (typeof branding.isotipo_url === 'string' && branding.isotipo_url) ||
      null;

    const recibo = {
      folio: String(p.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      fechaISO: p.created_at,
      gym: {
        nombre: (tenant?.nombre as string) || 'Gimnasio',
        logoUrl,
        direccion: pick<string>(config, 'landing', 'footer', 'direccion'),
        telefono: pick<string>(config, 'contacto', 'whatsapp_e164')
      },
      socio: (p.socio?.nombre as string) || 'Socio',
      concepto: p.concepto as string,
      tierNombre: (p.tier?.nombre as string | null) ?? null,
      metodo: p.metodo as string,
      montoCentavos: p.monto_centavos as number,
      moneda: (p.moneda as string) || 'MXN'
    };

    return ok({ recibo });
  } catch (err) {
    console.error('[recibo]', err instanceof Error ? err.message : err);
    return serverError('No pudimos generar el recibo');
  }
};