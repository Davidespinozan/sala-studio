import { describe, it, expect, vi, beforeEach } from 'vitest';

// BLOCK 2G: la contención del endpoint legacy no debe romper el nuevo.
// Orquestación de cancelacion-stripe: iniciar (RPC) → Stripe → confirmar (RPC).
// La autorización/cross-tenant vive en iniciar_operacion_cancelacion (SQL);
// acá se simula su respuesta y se verifica que el handler la respete.
const h = vi.hoisted(() => {
  class StripeConnectionError extends Error {}
  class StripeAPIError extends Error {}
  class StripeInvalidRequestError extends Error {}
  return {
    errors: { StripeConnectionError, StripeAPIError, StripeInvalidRequestError },
    subUpdate: vi.fn(),
    getUser: vi.fn(),
    rpc: vi.fn(),
    tablas: {} as Record<string, any>
  };
});

vi.mock('../_lib/stripe', () => ({
  getStripe: () => ({ subscriptions: { update: h.subUpdate } }),
  Stripe: { errors: h.errors }
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: h.getUser },
    rpc: h.rpc,
    from: (tabla: string) => {
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: h.tablas[tabla] ?? null })
      };
      return q;
    }
  })
}));

import { handler } from '../cancelacion-stripe/index';

function evento(body: unknown, auth: string | null = 'Bearer jwt') {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = auth;
  return { httpMethod: 'POST', headers, body: JSON.stringify(body) } as any;
}
const llamar = async (ev: any) => {
  const res: any = await handler(ev, {} as any, undefined as any);
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const rpcsLlamadas = (nombre: string) => h.rpc.mock.calls.filter((c) => c[0] === nombre);

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = 'http://x';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  h.subUpdate.mockReset();
  h.rpc.mockReset();
  h.getUser.mockReset();
  h.getUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
  h.tablas = {
    usuarios: { id: 'u-socio' },
    membresias: { tenant_id: 't-1' },
    tenants: { stripe_account_id: 'acct_1' },
    stripe_operaciones_cancelacion: null
  };
  h.rpc.mockImplementation(async (nombre: string) => {
    if (nombre === 'iniciar_operacion_cancelacion') {
      return { data: { ok: true, membresia_id: 'm-1', stripe_subscription_id: 'sub_1' }, error: null };
    }
    return { data: { ok: true, membresia_terminal: false }, error: null };
  });
  h.subUpdate.mockResolvedValue({ current_period_end: 1_900_000_000 });
});

describe('cancelacion-stripe (BLOCK2C) — sigue funcionando tras BLOCK2G', () => {
  it('programar: inicia → Stripe cancel_at_period_end:true en la cuenta Connect → confirma', async () => {
    const r = await llamar(evento({ usuario_id: 'u-socio', accion: 'programar' }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, estado: 'aplicado' });
    expect(h.subUpdate).toHaveBeenCalledTimes(1);
    expect(h.subUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true }, { stripeAccount: 'acct_1' });
    // BLOCK2H: confirmar_operacion_cancelacion ya no es callable por authenticated
    // (ver auditoría) — el handler debe pasar el actor YA verificado por el JWT,
    // nunca confiar en que el cliente lo mande.
    expect(rpcsLlamadas('confirmar_operacion_cancelacion')[0][1]).toMatchObject({ p_exito: true, p_actor_usuario_id: 'u-socio' });
  });

  it('retirar: Stripe cancel_at_period_end:false', async () => {
    const r = await llamar(evento({ usuario_id: 'u-socio', accion: 'retirar' }));
    expect(r.body.estado).toBe('aplicado');
    expect(h.subUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: false }, { stripeAccount: 'acct_1' });
  });

  it('sin token: 401 y cero llamadas a Stripe/RPC', async () => {
    const r = await llamar(evento({ usuario_id: 'u-socio', accion: 'programar' }, null));
    expect(r.status).toBe(401);
    expect(h.subUpdate).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('iniciar rechaza (ej. cross-tenant / sin permiso): 400 con el código y Stripe intacto', async () => {
    h.rpc.mockImplementation(async (nombre: string) =>
      nombre === 'iniciar_operacion_cancelacion'
        ? { data: null, error: { message: 'NO_AUTORIZADO: socio de otro negocio' } }
        : { data: null, error: null }
    );
    const r = await llamar(evento({ usuario_id: 'u-otro-tenant', accion: 'programar' }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^NO_AUTORIZADO:/);
    expect(h.subUpdate).not.toHaveBeenCalled();
  });

  it('membresía manual (iniciar la rechaza por no tener sub): Stripe intacto', async () => {
    h.rpc.mockImplementation(async (nombre: string) =>
      nombre === 'iniciar_operacion_cancelacion'
        ? { data: null, error: { message: 'SIN_SUSCRIPCION_STRIPE: membresía manual' } }
        : { data: null, error: null }
    );
    const r = await llamar(evento({ usuario_id: 'u-socio', accion: 'programar' }));
    expect(r.status).toBe(400);
    expect(h.subUpdate).not.toHaveBeenCalled();
  });

  it('operación BLOCK2 ya en curso: responde procesando sin tocar Stripe', async () => {
    h.rpc.mockImplementation(async () => ({ data: { ok: false, reason: 'operacion_en_curso' }, error: null }));
    const r = await llamar(evento({ usuario_id: 'u-socio', accion: 'programar' }));
    expect(r.body).toMatchObject({ estado: 'procesando', reason: 'operacion_en_curso' });
    expect(h.subUpdate).not.toHaveBeenCalled();
  });

  it('reintento con operacion_id ya resuelto del mismo actor: devuelve el resultado sin Stripe ni iniciar', async () => {
    h.tablas.stripe_operaciones_cancelacion = { estado: 'aplicada', resultado: { x: 1 } };
    const r = await llamar(evento({ usuario_id: 'u-socio', accion: 'programar', operacion_id: 'op-1' }));
    expect(r.body).toMatchObject({ ok: true, operacion_id: 'op-1', estado: 'aplicada' });
    expect(h.subUpdate).not.toHaveBeenCalled();
    expect(rpcsLlamadas('iniciar_operacion_cancelacion')).toHaveLength(0);
  });

  it('error ambiguo de Stripe (conexión): procesando, sin confirmar (lo resuelve el reconciliador)', async () => {
    h.subUpdate.mockRejectedValue(new h.errors.StripeConnectionError('ECONNRESET'));
    const r = await llamar(evento({ usuario_id: 'u-socio', accion: 'programar' }));
    expect(r.body.estado).toBe('procesando');
    expect(rpcsLlamadas('confirmar_operacion_cancelacion')).toHaveLength(0);
  });

  it('rechazo explícito de Stripe: confirma como fallo y 400', async () => {
    h.subUpdate.mockRejectedValue(new h.errors.StripeInvalidRequestError('No such subscription'));
    const r = await llamar(evento({ usuario_id: 'u-socio', accion: 'programar' }));
    expect(r.status).toBe(400);
    expect(rpcsLlamadas('confirmar_operacion_cancelacion')[0][1]).toMatchObject({ p_exito: false, p_actor_usuario_id: 'u-socio' });
  });

  it('sub mock_ (demo): no llama a Stripe y cierra la operación como fallo', async () => {
    h.rpc.mockImplementation(async (nombre: string) =>
      nombre === 'iniciar_operacion_cancelacion'
        ? { data: { ok: true, membresia_id: 'm-1', stripe_subscription_id: 'mock_sub' }, error: null }
        : { data: { ok: true }, error: null }
    );
    const r = await llamar(evento({ usuario_id: 'u-socio', accion: 'programar' }));
    expect(r.status).toBe(500);
    expect(h.subUpdate).not.toHaveBeenCalled();
    expect(rpcsLlamadas('confirmar_operacion_cancelacion')[0][1]).toMatchObject({ p_exito: false });
  });
});
