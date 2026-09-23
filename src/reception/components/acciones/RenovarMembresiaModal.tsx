import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { AccionModal } from '@shared/components/AccionModal';
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
  // Bloquea "Sin registrar cobro" sin confirmar pago en línea (ver MetodoPagoField).
  const [metodoListo, setMetodoListo] = useState(true);
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
      canConfirm={metodoListo}
      onConfirm={async () => {
        await ejecutar({
          p_usuario_id: socioId,
          // Motivo opcional: el método ya dice cómo se pagó. Si no ponen nota, el
          // historial guarda un motivo genérico para no quedar vacío.
          p_motivo: motivo.trim() || 'Renovación',
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
        onListoChange={setMetodoListo}
      />

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
