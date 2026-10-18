import { describe, it, expect, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@shared/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { apartarPlanParaRecepcion, traducirErrorApartarPlan } from '../elegirPlanRecepcion';

// "Pagar en recepción" desde la app (The Core, 18-oct-2026): aparta el plan sin
// tarjeta vía RPC; los códigos del backend llegan en español para el socio.
describe('apartarPlanParaRecepcion', () => {
  it('llama al RPC con el tier y devuelve el plan apartado', async () => {
    rpc.mockResolvedValueOnce({ data: { tier_id: 't1', tier_slug: 'paq-4', tier_nombre: '4 clases', precio_centavos: 85000 }, error: null });
    const res = await apartarPlanParaRecepcion('t1');
    expect(rpc).toHaveBeenCalledWith('socio_elegir_plan_recepcion', { p_tier_id: 't1' });
    expect(res.tier_nombre).toBe('4 clases');
  });
  it('error del RPC → mensaje traducido', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'YA_TIENE_PLAN: ya tienes una membresía vigente' } });
    await expect(apartarPlanParaRecepcion('t1')).rejects.toThrow(/membresía vigente/);
  });
  it('códigos conocidos y fallback', () => {
    expect(traducirErrorApartarPlan('PRUEBA_YA_USADA: x')).toMatch(/clase de prueba/);
    expect(traducirErrorApartarPlan('PLAN_NO_DISPONIBLE: x')).toMatch(/a la venta/);
    expect(traducirErrorApartarPlan('function socio_elegir_plan_recepcion does not exist')).toMatch(/pásate a recepción/);
  });
});
