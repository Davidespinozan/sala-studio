import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { AccionModal } from '@shared/components/AccionModal';
import { useAccionRecepcion } from '../../hooks/useAccionRecepcion';
import { MetodoPagoField, type MetodoPago } from './MetodoPagoField';
import { useOperationKey } from '@shared/lib/operationKey';
import { useCargosPendientes } from '@shared/hooks/useCargosPendientes';
import { AvisoCargoPendiente } from '@shared/components/CargoPendienteRow';

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
  /** Plan preelegido (el que el socio escogió al registrarse y no pagó). */
  tierInicialId?: string | null;
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

export function AsignarPlanModal({ socioId, socioNombre, tierInicialId, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const [tierId, setTierId] = useState(tierInicialId ?? '');
  const [tiers, setTiers] = useState<TierOption[]>([]);
  const [metodo, setMetodo] = useState<MetodoPago | ''>('efectivo');
  const [pendiente, setPendiente] = useState(false);
  // El campo de método reporta si la selección está lista (bloquea "Sin registrar
  // cobro" sin confirmar pago en línea). Default true: mientras no se elija ''.
  const [metodoListo, setMetodoListo] = useState(true);
  // Si ya debe algo "Por cobrar", seguramente vino a pagarlo: el aviso lo cobra
  // ahí y frena la renovación duplicada salvo que marquen "es compra nueva".
  const { cargos: cargosPendientes } = useCargosPendientes(socioId, isOpen);
  const [esCompraNueva, setEsCompraNueva] = useState(false);
  useEffect(() => {
    if (!isOpen) setEsCompraNueva(false);
  }, [isOpen]);
  const pendienteResuelto = cargosPendientes.length === 0 || esCompraNueva;
  const cobrarPendienteYCerrar = async () => {
    await onDone();
    onClose();
  };
  // La inscripción se cobra UNA vez por socio: si ya la pagó, no se vuelve a sumar.
  const [yaPagoInscripcion, setYaPagoInscripcion] = useState(false);
  // Y tampoco se cobra si el socio YA tuvo un plan antes (aunque haya entrado en un
  // periodo con inscripción gratis, con inscripcion_pagada_at en NULL).
  const [esSocioExistente, setEsSocioExistente] = useState(false);
  // Cortesía puntual: perdonarle la inscripción a un socio nuevo (amigo, familia, promo).
  const [exentar, setExentar] = useState(false);
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_asignar_plan' });
  // Idempotencia: una key por intención. Se regenera si cambia una entrada material
  // (plan, método, pendiente, exención, nota) para no chocar como conflicto.
  const operationKey = useOperationKey([socioId, tierId, motivo, metodo, pendiente, exentar]);

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
      canConfirm={
        tierId.length > 0 &&
        // No activar sin ningún registro: o queda pendiente, o el campo de método
        // está listo (método real, o "sin cobro" confirmado como pago en línea).
        (pendiente || metodoListo) &&
        pendienteResuelto
      }
      onConfirm={async () => {
        // Una sola llamada ATÓMICA: exentar (si aplica) + asignar/cobrar + dejar
        // "por cobrar" ocurren en UNA transacción de Postgres (recepcion_asignar_plan).
        // Si algo falla, no queda estado a medias. Idempotente por operation_key:
        // un reintento tras respuesta perdida converge, no duplica.
        const cargoMonto = tier ? (tier.precio_centavos ?? 0) + inscripcionACobrar : 0;
        const dejarPendiente = pendiente && cargoMonto > 0;
        await ejecutar({
          p_usuario_id: socioId,
          p_tier_id: tierId,
          p_motivo: motivo.trim() || 'Alta de plan',
          // Pendiente → se asigna el plan SIN cobro; el cobro queda "por cobrar".
          // Sin método → el plan se activa pero no se registra ningún cobro.
          p_metodo_pago: pendiente ? null : (metodo === '' ? null : metodo),
          p_operation_key: operationKey,
          p_exentar_inscripcion: exentar,
          p_dejar_pendiente: dejarPendiente,
          p_cargo_monto_centavos: dejarPendiente ? cargoMonto : null,
          p_cargo_descripcion: tier?.nombre ?? null
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
          onListoChange={setMetodoListo}
        />
      )}

      {tier && (yaPagoInscripcion || esSocioExistente) && (tier.inscripcion_centavos ?? 0) > 0 && (
        <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginBottom: '12px' }}>
          Este socio ya tuvo un plan antes, así que no se le cobra inscripción.
        </p>
      )}

      {/* Nota libre y OPCIONAL (el método ya registra el cobro). */}
      <div className="ek-form-field" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <label className="ek-label" htmlFor="asignar-nota">Nota (opcional)</label>
        <input
          id="asignar-nota"
          className="ek-input"
          type="text"
          placeholder="Ej. período de prueba, cortesía… (opcional)"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          autoComplete="off"
        />
      </div>
    </AccionModal>
  );
}
