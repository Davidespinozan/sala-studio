import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DemoBanner } from '../DemoBanner';

describe('DemoBanner', () => {
  it('NO renderiza si no hay ?demo=admin-preview en URL', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <DemoBanner vista="Landing" />
      </MemoryRouter>
    );
    expect(screen.queryByText(/Vista de demostración/i)).not.toBeInTheDocument();
  });

  it('renderiza si URL tiene ?demo=admin-preview', () => {
    render(
      <MemoryRouter initialEntries={['/?demo=admin-preview']}>
        <DemoBanner vista="Landing" />
      </MemoryRouter>
    );
    expect(screen.getByText(/Vista de demostración/i)).toBeInTheDocument();
    expect(screen.getByText(/Landing/i)).toBeInTheDocument();
  });

  it('muestra el nombre de vista correcto (Miembro)', () => {
    render(
      <MemoryRouter initialEntries={['/app?demo=admin-preview']}>
        <DemoBanner vista="Miembro" />
      </MemoryRouter>
    );
    expect(screen.getByText(/Miembro/i)).toBeInTheDocument();
  });

  it('muestra el nombre de vista correcto (Recepción)', () => {
    render(
      <MemoryRouter initialEntries={['/recepcion?demo=admin-preview']}>
        <DemoBanner vista="Recepción" />
      </MemoryRouter>
    );
    expect(screen.getByText(/Recepción/i)).toBeInTheDocument();
  });

  it('botón "Volver al admin" es clickeable y accesible', () => {
    render(
      <MemoryRouter initialEntries={['/?demo=admin-preview']}>
        <DemoBanner vista="Landing" />
      </MemoryRouter>
    );
    const btn = screen.getByRole('button', { name: /Volver al admin/i });
    expect(btn).toBeEnabled();
  });

  it('NO renderiza con un valor distinto de admin-preview', () => {
    render(
      <MemoryRouter initialEntries={['/?demo=otro-valor']}>
        <DemoBanner vista="Landing" />
      </MemoryRouter>
    );
    expect(screen.queryByText(/Vista de demostración/i)).not.toBeInTheDocument();
  });
});
