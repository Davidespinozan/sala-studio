import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { AccionModal } from '@shared/components/AccionModal';
import { MotivoField } from '@shared/components/MotivoField';
import { useAccionRecepcion } from '../../hooks/useAccionRecepcion';
import { MetodoPagoField, type MetodoPago } from './MetodoPagoField';

interface TierOption {
  id: string;
  nombre: string;
  precio_centavos: number;
  inscripcion_centavos: number;
  moneda: string;
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
  const [metodo, setMetodo] = useState<MetodoPago | ''>('efectivo');
  // La inscripción se cobra UNA vez por socio: si ya la pagó, no se vuelve a sumar.
  const [yaPagoInscripcion, setYaPagoInscripcion] = useState(false);
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_asignar_plan' });

  // Todos los tiers activos del tenant (no se excluye ninguno: es el primer plan).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: tiersData }, { data: socioData }] = await Promise.all([
        supabase
          .from('tiers')
          .select('id, nombre, precio_centavos, inscripcion_centavos, moneda')
          .eq('activo', true)
          .order('orden', { ascending: true }),
        supabase
          .from('usuarios')
          .select('inscripcion_pagada_at')
          .eq('id', socioId)
          .maybeSingle()
      ]);
      if (cancelled) return;
      setTiers((tiersData ?? []) as TierOption[]);
      setYaPagoInscripcion(socioData?.inscripcion_pagada_at != null);
    })();
    return () => {
      cancelled = true;
    };
  }, [socioId]);

  const tier = tiers.find((t) => t.id === tierId);
  const inscripcionACobrar = !tier || yaPagoInscripcion ? 0 : (tier.inscripcion_centavos ?? 0);

  return (
    <AccionModal
      isOpen={isOpen}
      title="Asignar plan"
      description={`Asignas el primer plan a ${socioNombre}. Se va a activar inmediatamente.`}
      variant="info"
      confirmLabel="Asignar plan"
      canConfirm={motivo.trim().length > 0 && tierId.length > 0}
      onConfirm={async () => {
        await ejecutar({
          p_usuario_id: socioId,
          p_tier_id: tierId,
          p_motivo: motivo,
          // Sin método → el plan se activa pero no se registra ningún cobro.
          p_metodo_pago: metodo === '' ? null : metodo
        });
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
          <option value="" disabled>Elige un plan…</option>
          {tiers.map((t) => (
            <option key={t.id} value={t.id}>{t.nombre}</option>
          ))}
        </select>
      </div>

      {tier && (
        <MetodoPagoField
          value={metodo}
          onChange={setMetodo}
          precioCentavos={tier.precio_centavos ?? 0}
          inscripcionCentavos={inscripcionACobrar}
          moneda={tier.moneda}
        />
      )}

      {tier && yaPagoInscripcion && (tier.inscripcion_centavos ?? 0) > 0 && (
        <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginBottom: '12px' }}>
          Este socio ya pagó inscripción antes, así que no se le vuelve a cobrar.
        </p>
      )}

      <MotivoField
        value={motivo}
        onChange={setMotivo}
        opciones={['Alta nueva con pago en efectivo', 'Alta nueva con transferencia', 'Cortesía del owner', 'Período de prueba']}
        label="Motivo del alta"
      />
    </AccionModal>
  );
}
