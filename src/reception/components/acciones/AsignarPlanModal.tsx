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
  const [pendiente, setPendiente] = useState(false);
  // La inscripción se cobra UNA vez por socio: si ya la pagó, no se vuelve a sumar.
  const [yaPagoInscripcion, setYaPagoInscripcion] = useState(false);
  // Y tampoco se cobra si el socio YA tuvo un plan antes (aunque haya entrado en un
  // periodo con inscripción gratis, con inscripcion_pagada_at en NULL).
  const [esSocioExistente, setEsSocioExistente] = useState(false);
  // Cortesía puntual: perdonarle la inscripción a un socio nuevo (amigo, familia, promo).
  const [exentar, setExentar] = useState(false);
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_asignar_plan' });

  // Todos los tiers activos del tenant (no se excluye ninguno: es el primer plan).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: tiersData }, { data: socioData, error: socioError }, { count: memCount }] = await Promise.all([
        supabase
          .from('tiers')
          .select('id, nombre, precio_centavos, inscripcion_centavos, moneda')
          .eq('activo', true)
          .order('orden', { ascending: true }),
        supabase
          .from('usuarios')
          .select('inscripcion_pagada_at')
          .eq('id', socioId)
          .maybeSingle(),
        // ¿Ya tuvo alguna membresía (cualquier estado)? Si sí, es socio existente →
        // no paga inscripción, aunque su plan viejo haya sido en periodo gratis.
        supabase
          .from('membresias')
          .select('id', { count: 'exact', head: true })
          .eq('usuario_id', socioId)
      ]);
      if (cancelled) return;
      setTiers((tiersData ?? []) as TierOption[]);
      setEsSocioExistente((memCount ?? 0) > 0);
      // Sin este log, el fallo era MUDO: la columna estaba fuera del GRANT de
      // authenticated, la query moría por permisos, socioData quedaba null y
      // esto daba `false` — o sea, "no pagó la inscripción" para todos. La
      // pantalla le sumaba la inscripción a socios que ya la habían pagado.
      if (socioError) console.error('[AsignarPlanModal] inscripcion_pagada_at:', socioError.message);
      setYaPagoInscripcion(socioData?.inscripcion_pagada_at != null);
    })();
    return () => {
      cancelled = true;
    };
  }, [socioId]);

  const tier = tiers.find((t) => t.id === tierId);
  const inscripcionACobrar =
    !tier || yaPagoInscripcion || esSocioExistente || exentar ? 0 : (tier.inscripcion_centavos ?? 0);

  return (
    <AccionModal
      isOpen={isOpen}
      title="Asignar plan"
      description={`Asignas el primer plan a ${socioNombre}. Se va a activar inmediatamente.`}
      variant="info"
      confirmLabel="Asignar plan"
      canConfirm={motivo.trim().length > 0 && tierId.length > 0}
      onConfirm={async () => {
        // Cast para RPCs que aún no están en los tipos generados.
        const rpc = supabase.rpc.bind(supabase) as unknown as (
          name: string,
          args: Record<string, unknown>
        ) => Promise<{ data: unknown; error: { message: string } | null }>;

        // Cortesía: si se marcó "no cobrar inscripción", se exenta ANTES de asignar
        // para que el motor no la registre (lee usuarios.inscripcion_pagada_at).
        if (exentar) {
          const { error } = await rpc('exentar_inscripcion_socio', { p_usuario_id: socioId });
          if (error) throw new Error('No se pudo exentar la inscripción: ' + error.message);
        }

        await ejecutar({
          p_usuario_id: socioId,
          p_tier_id: tierId,
          p_motivo: motivo,
          // Pendiente → se asigna el plan SIN cobro; el cobro queda "por cobrar".
          // Sin método → el plan se activa pero no se registra ningún cobro.
          p_metodo_pago: pendiente ? null : (metodo === '' ? null : metodo)
        });
        if (pendiente && tier) {
          const monto = (tier.precio_centavos ?? 0) + inscripcionACobrar;
          if (monto > 0) {
            const { error } = await rpc('registrar_cargo_pendiente', {
              p_usuario_id: socioId,
              p_monto_centavos: monto,
              p_concepto: 'plan',
              p_descripcion: tier.nombre
            });
            if (error) {
              throw new Error('El plan se asignó, pero no se pudo dejar el pendiente: ' + error.message);
            }
          }
        }
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
        <div className="ek-form-field" style={{ marginBottom: '12px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
            <input type="checkbox" checked={pendiente} onChange={(e) => setPendiente(e.target.checked)} />
            Dejar pendiente (pagar al llegar)
          </label>
          {pendiente && (
            <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px', lineHeight: 1.45 }}>
              El plan se activa ya. El cobro queda <strong>“Por cobrar”</strong> y se cobra en la Caja cuando llegue — no cuenta como ingreso ni como cortesía hasta entonces.
            </p>
          )}
        </div>
      )}

      {tier && !yaPagoInscripcion && !esSocioExistente && (tier.inscripcion_centavos ?? 0) > 0 && (
        <div className="ek-form-field" style={{ marginBottom: '12px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
            <input type="checkbox" checked={exentar} onChange={(e) => setExentar(e.target.checked)} />
            No cobrar inscripción (cortesía)
          </label>
          {exentar && (
            <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px', lineHeight: 1.45 }}>
              Este socio queda exento de la inscripción para siempre (no se le cobrará ni ahora ni al recomprar).
            </p>
          )}
        </div>
      )}

      {tier && !pendiente && (
        <MetodoPagoField
          value={metodo}
          onChange={setMetodo}
          precioCentavos={tier.precio_centavos ?? 0}
          inscripcionCentavos={inscripcionACobrar}
          moneda={tier.moneda}
        />
      )}

      {tier && (yaPagoInscripcion || esSocioExistente) && (tier.inscripcion_centavos ?? 0) > 0 && (
        <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginBottom: '12px' }}>
          Este socio ya tuvo un plan antes, así que no se le cobra inscripción.
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
