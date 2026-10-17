import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const estadoAuth = { usuario: { status: 'activo' } as { status: string } };
const cobraOnline = { valor: true };
vi.mock('@member/hooks/useMembresiaActual', () => ({
  useMembresiaActual: () => ({ membresia: null, isLoading: false }),
  membresiaEstado: () => 'sin_membresia'
}));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => estadoAuth }));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't1', nombre: 'Gym', config: {} }) }));
vi.mock('@shared/lib/cobrosDelGym', () => ({ socioPuedePagarEnApp: () => cobraOnline.valor }));
vi.mock('../ContactoGymCTA', () => ({ default: () => null }));

import EstadoMembresiaBanner from '../EstadoMembresiaBanner';

const montar = () => render(<MemoryRouter><EstadoMembresiaBanner /></MemoryRouter>);

// Cuenta creada sin plan (acceso_sin_plan): el banner dice CÓMO activar el
// paquete y lleva al selector; antes decía "contacta al gimnasio".
describe('EstadoMembresiaBanner · cuenta pendiente sin plan', () => {
  it('socio activo sin membresía: texto genérico de siempre', () => {
    estadoAuth.usuario = { status: 'activo' };
    montar();
    expect(screen.getByText('Elige tu plan')).toBeTruthy();
    expect(screen.queryByText('Activar mi paquete')).toBeNull();
  });
  it('pendiente_pago con cobro en la app: "pagarlo aquí o en recepción" y CTA al selector', () => {
    estadoAuth.usuario = { status: 'pendiente_pago' };
    cobraOnline.valor = true;
    montar();
    expect(screen.getByText(/pagarlo aquí en la app o en recepción/)).toBeTruthy();
    const cta = screen.getByText('Activar mi paquete').closest('a');
    expect(cta?.getAttribute('href')).toBe('/app/perfil?elegir=1');
  });
  it('pendiente_pago en gym solo recepción: manda a recepción', () => {
    estadoAuth.usuario = { status: 'pendiente_pago' };
    cobraOnline.valor = false;
    montar();
    expect(screen.getByText(/pagándolo en recepción/)).toBeTruthy();
  });
});
