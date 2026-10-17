import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../../hooks/useSocios', () => ({ useSocios: () => ({ socios: [], isLoading: false }) }));
vi.mock('@shared/components/Avatar', () => ({ Avatar: () => null }));

import { ElegirSocioModal } from '../ElegirSocioModal';

// Walk-in nuevo desde la Agenda: antes decía "dalo de alta en Socios" y había que
// salirse de la clase; ahora el alta se abre ahí mismo y encadena plan → reserva.
describe('ElegirSocioModal · nuevo socio', () => {
  it('sin onNuevo no ofrece el atajo (compatibilidad)', () => {
    render(<ElegirSocioModal titulo="Yoga · Hoy 7:00" onElegir={() => {}} onClose={() => {}} />);
    expect(screen.queryByText('+ Nuevo socio')).toBeNull();
  });
  it('con onNuevo muestra el botón y lo dispara', () => {
    const onNuevo = vi.fn();
    render(<ElegirSocioModal titulo="Yoga · Hoy 7:00" onElegir={() => {}} onClose={() => {}} onNuevo={onNuevo} />);
    fireEvent.click(screen.getByText('+ Nuevo socio'));
    expect(onNuevo).toHaveBeenCalledTimes(1);
  });
});
