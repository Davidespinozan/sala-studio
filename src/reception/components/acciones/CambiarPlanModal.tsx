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
  tierActualId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

export function CambiarPlanModal({ socioId, socioNombre, tierActualId, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const [nuevoTierId, setNuevoTierId] = useState('');
  const [tiers, setTiers] = useState<TierOption[]>([]);
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_cambiar_plan' });

  // Tiers activos del tenant (RLS scopea), excluyendo el plan actual.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let req = supabase
        .from('tiers')
        .select('id, nombre')
        .eq('activo', true)
        .order('orden', { ascending: true });
      if (tierActualId) req = req.neq('id', tierActualId);
      const { data } = await req;
      if (!cancelled) setTiers((data ?? []) as TierOption[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [tierActualId]);

  return (
    <AccionModal
      isOpen={isOpen}
      title="Cambiar de plan"
      description={`Asignas un plan distinto a ${socioNombre}.`}
      variant="info"
      confirmLabel="Cambiar plan"
      canConfirm={motivo.trim().length > 0 && nuevoTierId.length > 0}
      onConfirm={async () => {
        await ejecutar({ p_usuario_id: socioId, p_nuevo_tier_id: nuevoTierId, p_motivo: motivo });
        await onDone();
      }}
      onClose={onClose}
    >
      <div className="ek-form-field" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
        <label className="ek-label" htmlFor="cambiar-plan-tier">Nuevo plan</label>
        <select
          id="cambiar-plan-tier"
          className="ek-input"
          value={nuevoTierId}
          onChange={(e) => setNuevoTierId(e.target.value)}
        >
          <option value="" disabled>Elige un plan…</option>
          {tiers.map((t) => (
            <option key={t.id} value={t.id}>{t.nombre}</option>
          ))}
        </select>
      </div>

      <MotivoField
        value={motivo}
        onChange={setMotivo}
        opciones={['Upgrade del cliente', 'Downgrade', 'Cambio de modalidad', 'Cortesía del owner']}
        label="Motivo del cambio"
      />
    </AccionModal>
  );
}
