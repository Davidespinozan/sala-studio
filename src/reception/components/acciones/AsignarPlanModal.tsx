import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { AccionModal } from '@shared/components/AccionModal';
import { MotivoField } from '@shared/components/MotivoField';
import { useAccionRecepcion } from '../../hooks/useAccionRecepcion';

interface TierOption {
  id: string;
  nombre: string;
}

interface Props {
  socioId: string;
  socioNombre: string;
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

export function AsignarPlanModal({ socioId, socioNombre, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const [tierId, setTierId] = useState('');
  const [tiers, setTiers] = useState<TierOption[]>([]);
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_asignar_plan' });

  // Todos los tiers activos del tenant (no se excluye ninguno: es el primer plan).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('tiers')
        .select('id, nombre')
        .eq('activo', true)
        .order('orden', { ascending: true });
      if (!cancelled) setTiers((data ?? []) as TierOption[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AccionModal
      isOpen={isOpen}
      title="Asignar plan"
      description={`Asignás el primer plan a ${socioNombre}. Se va a activar inmediatamente.`}
      variant="info"
      confirmLabel="Asignar plan"
      canConfirm={motivo.trim().length > 0 && tierId.length > 0}
      onConfirm={async () => {
        await ejecutar({ p_usuario_id: socioId, p_tier_id: tierId, p_motivo: motivo });
        await onDone();
      }}
      onClose={onClose}
    >
      <div className="ek-form-field" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
        <label className="ek-label" htmlFor="asignar-plan-tier">Plan</label>
        <select
          id="asignar-plan-tier"
          className="ek-input"
          value={tierId}
          onChange={(e) => setTierId(e.target.value)}
        >
          <option value="" disabled>Elegí un plan…</option>
          {tiers.map((t) => (
            <option key={t.id} value={t.id}>{t.nombre}</option>
          ))}
        </select>
      </div>

      <MotivoField
        value={motivo}
        onChange={setMotivo}
        opciones={['Alta nueva con pago en efectivo', 'Alta nueva con transferencia', 'Cortesía del owner', 'Período de prueba']}
        label="Motivo del alta"
      />
    </AccionModal>
  );
}
