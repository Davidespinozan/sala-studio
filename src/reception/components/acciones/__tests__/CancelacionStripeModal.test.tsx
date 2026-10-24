import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';
import { CancelacionStripeModal } from '../CancelacionStripeModal';

const llamarMock = vi.fn();
vi.mock('@shared/lib/cancelacionStripe', () => ({
  llamarCancelacionStripe: (...args: unknown[]) => llamarMock(...args)
}));

function renderModal(props: Partial<React.ComponentProps<typeof CancelacionStripeModal>> = {}) {
  const onClose = vi.fn();
  const onDone = vi.fn().mockResolvedValue(undefined);
  render(
    <ToastProvider>
      <CancelacionStripeModal
        socioId="socio-1"
        socioNombre="Ana"
        modo="programar"
        isOpen
        onClose={onClose}
        onDone={onDone}
        {...props}
      />
    </ToastProvider>
  );
  return { onClose, onDone };
}

function elegirMotivo(texto: string) {
  const select = screen.getByLabelText(/motivo/i);
  fireEvent.change(select, { target: { value: texto } });
}

describe('CancelacionStripeModal', () => {
  beforeEach(() => {
    llamarMock.mockReset();
  });

  it('el botón Confirmar queda deshabilitado sin motivo', () => {
    renderModal();
    const btn = screen.getByRole('button', { name: /Programar cancelación/i });
    expect(btn).toBeDisabled();
  });

  it('programar: llama a llamarCancelacionStripe con accion=programar y motivo, cierra en éxito', async () => {
    llamarMock.mockResolvedValue({ ok: true, estado: 'aplicado' });
    const { onClose, onDone } = renderModal({ modo: 'programar' });
    elegirMotivo('Solicitud del cliente');
    fireEvent.click(screen.getByRole('button', { name: /Programar cancelación/i }));

    await waitFor(() => expect(llamarMock).toHaveBeenCalledWith({
      usuarioId: 'socio-1',
      accion: 'programar',
      motivo: 'Solicitud del cliente'
    }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await screen.findByText(/Cancelación programada/i)).toBeInTheDocument();
  });

  it('retirar: llama con accion=retirar', async () => {
    llamarMock.mockResolvedValue({ ok: true, estado: 'aplicado' });
    renderModal({ modo: 'retirar' });
    elegirMotivo('Cambio de opinión');
    fireEvent.click(screen.getByRole('button', { name: /Retirar cancelación/i }));
    await waitFor(() => expect(llamarMock).toHaveBeenCalledWith({
      usuarioId: 'socio-1',
      accion: 'retirar',
      motivo: 'Cambio de opinión'
    }));
  });

  it('resultado procesando: muestra aviso de procesando y de todos modos cierra (no promete éxito ni error)', async () => {
    llamarMock.mockResolvedValue({ ok: true, estado: 'procesando' });
    const { onClose, onDone } = renderModal();
    elegirMotivo('Decisión del owner');
    fireEvent.click(screen.getByRole('button', { name: /Programar cancelación/i }));

    expect(await screen.findByText(/quedó procesándose/i)).toBeInTheDocument();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('error (ej. CANCELACION_YA_PENDIENTE): NO cierra el modal, muestra el mensaje traducido inline', async () => {
    llamarMock.mockRejectedValue(new Error('CANCELACION_YA_PENDIENTE: ya hay una cancelación programada'));
    const { onClose, onDone } = renderModal();
    elegirMotivo('Solicitud del cliente');
    fireEvent.click(screen.getByRole('button', { name: /Programar cancelación/i }));

    expect(await screen.findByText(/Ya hay una cancelación programada para esta membresía/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('membresía terminal: informa sin reclamar cambio', async () => {
    llamarMock.mockResolvedValue({ ok: true, estado: 'sin_efecto_membresia_terminal' });
    renderModal();
    elegirMotivo('Cierre de cuenta');
    fireEvent.click(screen.getByRole('button', { name: /Programar cancelación/i }));
    expect(await screen.findByText(/ya está cerrada; no hubo cambios/i)).toBeInTheDocument();
  });
});
