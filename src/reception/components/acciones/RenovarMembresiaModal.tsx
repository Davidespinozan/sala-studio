import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { AccionModal } from '@shared/components/AccionModal';
import { MotivoField } from '@shared/components/MotivoField';
import { useAccionRecepcion } from '../../hooks/useAccionRecepcion';
import { MetodoPagoField, type MetodoPago } from './MetodoPagoField';

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
  // Precio del plan que el socio ya tiene (renovar = mismo tier).
  const [precio, setPrecio] = useState<{ centavos: number; moneda: string } | null>(null);
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_renovar_membresia' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('membresias')
        .select('tiers(precio_centavos, moneda)')
        .eq('usuario_id', socioId)
        .in('status', ['activa', 'expirada', 'past_due', 'congelada'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      const t = (data as { tiers?: { precio_centavos: number; moneda: string } | null } | null)?.tiers;
      setPrecio(t ? { centavos: t.precio_centavos, moneda: t.moneda } : null);
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
      canConfirm={motivo.trim().length > 0}
      onConfirm={async () => {
        await ejecutar({
          p_usuario_id: socioId,
          p_motivo: motivo,
          p_metodo_pago: metodo === '' ? null : metodo
        });
        await onDone();
      }}
      onClose={onClose}
    >
      {/* Al renovar NO se cobra inscripción: es una cuota única de alta. */}
      <MetodoPagoField
        value={metodo}
        onChange={setMetodo}
        precioCentavos={precio?.centavos ?? 0}
        inscripcionCentavos={0}
        moneda={precio?.moneda}
      />

      <MotivoField
        value={motivo}
        onChange={setMotivo}
        opciones={['Pago en efectivo', 'Pago por transferencia', 'Cortesía del owner', 'Renovación automática mensual']}
        label="Motivo de la renovación"
      />
    </AccionModal>
  );
}
