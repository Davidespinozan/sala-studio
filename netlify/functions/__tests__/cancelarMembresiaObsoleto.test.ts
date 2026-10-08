import { describe, it, expect, vi, beforeEach } from 'vitest';

// BLOCK 2G: `cancelar-membresia` ya no debe poder llamar a Stripe bajo NINGUNA
// circunstancia. Mockeamos `_lib/stripe` igual que el resto de los tests de
// funciones Netlify — aunque el handler actual ya no lo importa, dejar el mock
// sirve de red de seguridad: si algún día alguien reintroduce la llamada, este
// test la detecta (el spy quedaría invocado).
const h = vi.hoisted(() => ({
  subUpdate: vi.fn(),
  subRetrieve: vi.fn(),
  getUser: vi.fn(),
  createClient: vi.fn()
}));

vi.mock('../_lib/stripe', () => ({
  getStripe: () => ({
    subscriptions: { update: h.subUpdate, retrieve: h.subRetrieve }
  }),
  Stripe: class {}
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...a: unknown[]) => (h.createClient(...a), {
    auth: { getUser: h.getUser },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) })
    })
  })
}));

import { handler } from '../cancelar-membresia/index';

function evento(opts: { body?: unknown; auth?: string | null; method?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.auth !== null) headers.authorization = opts.auth ?? 'Bearer token-de-un-socio-real';
  return {
    httpMethod: opts.method ?? 'POST',
    headers,
    body: opts.body === undefined ? JSON.stringify({}) : JSON.stringify(opts.body)
  } as any;
}

describe('cancelar-membresia (BLOCK2G — contención legacy)', () => {
  beforeEach(() => {
    h.subUpdate.mockReset();
    h.subRetrieve.mockReset();
    h.getUser.mockReset();
    h.createClient.mockReset();
    h.getUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
  });

  async function esperarObsoleto(res: any) {
    // 200 a propósito: el Perfil viejo trata todo no-2xx como "Probá de nuevo".
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ ok: false, reason: 'stripe_pendiente', codigo: 'CANCELACION_ENDPOINT_OBSOLETO' });
    expect(body.error).toMatch(/^CANCELACION_ENDPOINT_OBSOLETO:/);
    expect(h.subUpdate).not.toHaveBeenCalled();
    // Ni Supabase: no lee membresía, ni operación BLOCK2, ni tenant.
    expect(h.createClient).not.toHaveBeenCalled();
  }

  it('cliente PWA viejo intenta PROGRAMAR (reactivar omitido): obsoleto, sin tocar Stripe', async () => {
    const res = await handler(evento({ body: {} }), {} as any, undefined as any);
    await esperarObsoleto(res);
  });

  it('cliente PWA viejo intenta PROGRAMAR explícito (reactivar:false): obsoleto, sin tocar Stripe', async () => {
    const res = await handler(evento({ body: { reactivar: false } }), {} as any, undefined as any);
    await esperarObsoleto(res);
  });

  it('cliente PWA viejo intenta REACTIVAR (reactivar:true): obsoleto, sin tocar Stripe', async () => {
    const res = await handler(evento({ body: { reactivar: true } }), {} as any, undefined as any);
    await esperarObsoleto(res);
  });

  it('usuario autenticado (Bearer presente): misma respuesta obsoleta', async () => {
    const res = await handler(evento({ auth: 'Bearer valido-123' }), {} as any, undefined as any);
    await esperarObsoleto(res);
    expect(h.getUser).not.toHaveBeenCalled(); // ni siquiera se resuelve el actor
  });

  it('usuario NO autenticado (sin header Authorization): misma respuesta obsoleta', async () => {
    const res = await handler(evento({ auth: null }), {} as any, undefined as any);
    await esperarObsoleto(res);
  });

  it('body simulando una membresía manual (sin stripe_subscription_id implícito): obsoleto igual', async () => {
    const res = await handler(evento({ body: { reactivar: false, usuario_id: 'socio-manual' } }), {} as any, undefined as any);
    await esperarObsoleto(res);
  });

  it('body simulando una membresía Stripe real: obsoleto igual (nunca llega a leerla)', async () => {
    const res = await handler(evento({ body: { reactivar: false, usuario_id: 'socio-stripe' } }), {} as any, undefined as any);
    await esperarObsoleto(res);
  });

  it('body con pistas de cross-tenant: obsoleto igual (nunca resuelve tenant)', async () => {
    const res = await handler(evento({ body: { reactivar: true, tenant_id: 'otro-tenant' } }), {} as any, undefined as any);
    await esperarObsoleto(res);
  });

  it('body malformado (no JSON): no revienta, responde obsoleto igual', async () => {
    const res = await handler(
      { httpMethod: 'POST', headers: {}, body: '{ esto no es json' } as any,
      {} as any,
      undefined as any
    );
    await esperarObsoleto(res);
  });

  it('método GET: también obsoleto (fail-closed independiente del método)', async () => {
    const res = await handler(evento({ method: 'GET' }), {} as any, undefined as any);
    await esperarObsoleto(res);
  });

  // Réplica de la decisión del Perfil viejo (HEAD 86e9ac8, src/member/pages/
  // Perfil.tsx cancelar()/reactivar()): con este contrato cae en el mensaje
  // "habla con el gym", nunca en éxito ni en "Probá de nuevo".
  it('el cliente viejo, al PROGRAMAR, muestra "habla con {gym}" (no éxito, no reintento)', async () => {
    const res = JSON.parse((await handler(evento({ body: { reactivar: false } }), {} as any, undefined as any) as any).body);
    const toast = res.ok ? 'exito' : res.reason === 'sin_suscripcion' ? 'paquete'
      : res.reason === 'stripe_pendiente' ? 'habla_con_gym' : 'proba_de_nuevo';
    expect(toast).toBe('habla_con_gym');
  });

  it('el cliente viejo, al REACTIVAR, no muestra éxito ni recarga', async () => {
    const res = JSON.parse((await handler(evento({ body: { reactivar: true } }), {} as any, undefined as any) as any).body);
    expect(res.ok).toBe(false);
  });

  it('con una operación BLOCK2 en curso o sin iniciar: idéntico (no consulta stripe_operaciones_cancelacion)', async () => {
    await esperarObsoleto(await handler(evento({ body: { reactivar: false, operacion_id: 'op-en-curso' } }), {} as any, undefined as any));
    await esperarObsoleto(await handler(evento({ body: { reactivar: true } }), {} as any, undefined as any));
  });

  it('al final de toda la corrida: cero llamadas mutantes a Stripe desde este endpoint', () => {
    expect(h.subUpdate).not.toHaveBeenCalled();
  });
});
