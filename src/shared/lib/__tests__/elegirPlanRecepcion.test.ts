import { describe, it, expect, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@shared/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { apartarPlanParaRecepcion, activarPlanPorCobrar, traducirErrorApartarPlan, cancelarPlanPorCobrar, traducirErrorCancelarPorCobrar, esPlanPorCobrar } from '../elegirPlanRecepcion';

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

describe('activarPlanPorCobrar', () => {
  it('llama al RPC y devuelve monto + plan', async () => {
    rpc.mockResolvedValueOnce({ data: { tier_id: 't1', tier_nombre: '4 clases', monto_centavos: 85000, inscripcion_centavos: 0, cargo_id: 'c1', periodo_actual_fin: null, creditos_restantes: 4 }, error: null });
    const res = await activarPlanPorCobrar('t1');
    expect(rpc).toHaveBeenCalledWith('socio_activar_plan_por_cobrar', { p_tier_id: 't1' });
    expect(res.monto_centavos).toBe(85000);
  });
  it('gym sin el toggle → mensaje claro', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'NO_DISPONIBLE: este gimnasio no activa planes por cobrar desde la app' } });
    await expect(activarPlanPorCobrar('t1')).rejects.toThrow(/Pásate a recepción/);
  });
  it('ya debe algo → no apila', () => {
    expect(traducirErrorApartarPlan('CARGO_PENDIENTE_EXISTE: x')).toMatch(/pago pendiente/);
  });
});

// Plan "por cobrar" que la socia cancela desde la app (The Core, 22-oct-2026):
// antes "Cancelar suscripción" decía que un paquete no se cancela y la socia se
// quedaba con un plan apartado sin salida.
describe('cancelarPlanPorCobrar', () => {
  it('llama al RPC sin argumentos y devuelve el resultado', async () => {
    rpc.mockResolvedValueOnce({ data: { plan_cancelado: true, membresia_id: 'm1', tier_nombre: 'Clase prueba', cargos_cancelados: 1, prueba_liberada: true }, error: null });
    const res = await cancelarPlanPorCobrar();
    expect(rpc).toHaveBeenCalledWith('socio_cancelar_plan_por_cobrar');
    expect(res.prueba_liberada).toBe(true);
  });
  it('plan con pagos → mensaje que manda a recepción', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'PLAN_PAGADO: tu plan ya tiene pagos registrados' } });
    await expect(cancelarPlanPorCobrar()).rejects.toThrow(/recepción/);
  });
  it('códigos conocidos y fallback', () => {
    expect(traducirErrorCancelarPorCobrar('SIN_PLAN: x')).toMatch(/plan activo/);
    expect(traducirErrorCancelarPorCobrar('NO_POR_COBRAR: x')).toMatch(/pendiente de pago/);
    expect(traducirErrorCancelarPorCobrar('function does not exist')).toMatch(/Intenta de nuevo/);
  });
});

describe('esPlanPorCobrar', () => {
  it('membresía + cargo de plan pendiente = por cobrar', () => {
    expect(esPlanPorCobrar(true, [{ concepto: 'plan' }])).toBe(true);
  });
  it('sin membresía, o solo otros cargos (multa, producto), no lo es', () => {
    expect(esPlanPorCobrar(false, [{ concepto: 'plan' }])).toBe(false);
    expect(esPlanPorCobrar(true, [{ concepto: 'producto' }])).toBe(false);
    expect(esPlanPorCobrar(true, [])).toBe(false);
  });
});
