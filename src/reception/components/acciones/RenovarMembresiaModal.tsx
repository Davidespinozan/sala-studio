import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { AccionModal } from '@shared/components/AccionModal';
import { useAccionRecepcion } from '../../hooks/useAccionRecepcion';
import { MetodoPagoField, type MetodoPago } from './MetodoPagoField';
import { useOperationKey } from '@shared/lib/operationKey';
import { useCargosPendientes } from '@shared/hooks/useCargosPendientes';
import { AvisoCargoPendiente } from '@shared/components/CargoPendienteRow';
import { usePreciosPlanes } from '@shared/hooks/usePreciosPlanes';

interface Props {
  socioId: string;
  socioNombre: string;
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

export function RenovarMembresiaModal({ socioId, socioNombre, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const [metodo, setMetodo] = useState<MetodoPago | ''>('efectivo');
  // Bloquea "Sin registrar cobro" sin confirmar pago en línea (ver MetodoPagoField).
  const [metodoListo, setMetodoListo] = useState(true);
  // Renueva ya y el cobro queda "Por cobrar" (igual que en Asignar plan).
  const [pendiente, setPendiente] = useState(false);
  // Precio del plan que el socio ya tiene (renovar = mismo tier).
  const [precio, setPrecio] = useState<{ tierId: string; centavos: number; moneda: string } | null>(null);
  // Descuento vigente del socio (estudiante…): lo calcula la base, igual que el cobro.
  const { precioDe } = usePreciosPlanes(socioId, 'recepcion', isOpen);
  const precioSocio = precioDe(precio?.tierId);
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_renovar_membresia' });
  // Idempotencia: reintento tras respuesta perdida no vuelve a apilar el período ni recobra.
  const operationKey = useOperationKey([socioId, motivo, metodo, pendiente]);
  // Si ya debe algo "Por cobrar", seguramente vino a pagarlo: el aviso lo cobra
  // ahí y frena la renovación duplicada salvo que marquen "es compra nueva".
  const { cargos: cargosPendientes } = useCargosPendientes(socioId, isOpen);
  const [esCompraNueva, setEsCompraNueva] = useState(false);
  useEffect(() => {
    if (!isOpen) {
      setEsCompraNueva(false);
      setPendiente(false);
    }
  }, [isOpen]);
  // El "por cobrar" lleva el mismo descuento que el cobro inmediato.
  const cargoMonto = (precio?.centavos ?? 0) - (precioSocio?.descuento_centavos ?? 0);
  const dejarPendiente = pendiente && cargoMonto > 0;
  const pendienteResuelto = cargosPendientes.length === 0 || esCompraNueva;
  const cobrarPendienteYCerrar = async () => {
    await onDone();
    onClose();
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('membresias')
        .select('tiers(id, precio_centavos, moneda)')
        .eq('usuario_id', socioId)
        .in('status', ['activa', 'expirada', 'past_due', 'congelada'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      const t = (data as { tiers?: { id: string; precio_centavos: number; moneda: string } | null } | null)?.tiers;
      setPrecio(t ? { tierId: t.id, centavos: t.precio_centavos, moneda: t.moneda } : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [socioId]);

  return (
    <AccionModal
      isOpen={isOpen}
      title="Renovar membresía"
      description={`Renuevas el mismo plan a ${socioNombre}. Refresca el período y los créditos según el tier.`}
      variant="info"
      confirmLabel="Renovar"
      canConfirm={(dejarPendiente || metodoListo) && pendienteResuelto}
      onConfirm={async () => {
        await ejecutar({
          p_usuario_id: socioId,
          // Motivo opcional: el método ya dice cómo se pagó. Si no ponen nota, el
          // historial guarda un motivo genérico para no quedar vacío.
          p_motivo: motivo.trim() || 'Renovación',
          // Pendiente → se renueva SIN cobro; el cobro queda "por cobrar".
          p_metodo_pago: dejarPendiente ? null : (metodo === '' ? null : metodo),
          p_operation_key: operationKey,
          p_dejar_pendiente: dejarPendiente,
          p_cargo_monto_centavos: dejarPendiente ? cargoMonto : null
        });
        await onDone();
      }}
      onClose={onClose}
    >
      <AvisoCargoPendiente
        cargos={cargosPendientes}
        esCompraNueva={esCompraNueva}
        onEsCompraNuevaChange={setEsCompraNueva}
        onCobrado={cobrarPendienteYCerrar}
      />

      {cargoMonto > 0 && (
        <div className="ek-form-field" style={{ marginBottom: '12px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
            <input type="checkbox" checked={pendiente} onChange={(e) => setPendiente(e.target.checked)} />
            Dejar pendiente (pagar al llegar)
          </label>
          {pendiente && (
            <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px', lineHeight: 1.45 }}>
              El plan se renueva ya. El cobro queda <strong>“Por cobrar”</strong> y se cobra en la Caja cuando llegue — no cuenta como ingreso ni como cortesía hasta entonces.
            </p>
          )}
        </div>
      )}

      {/* Al renovar NO se cobra inscripción: es una cuota única de alta. */}
      {!dejarPendiente && (
      <MetodoPagoField
        value={metodo}
        onChange={setMetodo}
        precioCentavos={precio?.centavos ?? 0}
        inscripcionCentavos={0}
        descuentoCentavos={precioSocio?.descuento_centavos ?? 0}
        descuentoEtiqueta={precioSocio?.etiqueta}
        moneda={precio?.moneda}
        onListoChange={setMetodoListo}
      />
      )}

      {/* Nota libre y OPCIONAL: el método ya dice cómo se pagó. Solo para dejar un
          apunte si hace falta (ajuste, cortesía, etc.). No es un desplegable. */}
      <div className="ek-form-field" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <label className="ek-label" htmlFor="renovar-nota">Nota (opcional)</label>
        <input
          id="renovar-nota"
          className="ek-input"
          type="text"
          placeholder="Ej. ajuste, cortesía… (opcional)"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          autoComplete="off"
        />
      </div>
    </AccionModal>
  );
}
