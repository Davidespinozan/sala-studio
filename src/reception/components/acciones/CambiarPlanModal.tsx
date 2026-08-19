import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { AccionModal } from '@shared/components/AccionModal';
import { MotivoField } from '@shared/components/MotivoField';
import { useAccionRecepcion } from '../../hooks/useAccionRecepcion';
import { MetodoPagoField, type MetodoPago } from './MetodoPagoField';

interface TierOption {
  id: string;
  nombre: string;
  precio_centavos: number;
  moneda: string;
  tipo: string;
}

interface Props {
  socioId: string;
  socioNombre: string;
  tierActualId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

/** Clases sin usar del socio, y de qué TIPO es el plan que las tiene. */
interface SaldoActual {
  creditos: number;
  tipo: string;
}

export function CambiarPlanModal({ socioId, socioNombre, tierActualId, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const [nuevoTierId, setNuevoTierId] = useState('');
  const [tiers, setTiers] = useState<TierOption[]>([]);
  const [saldo, setSaldo] = useState<SaldoActual | null>(null);
  const [aceptaPerdida, setAceptaPerdida] = useState(false);
  const [metodo, setMetodo] = useState<MetodoPago | ''>('efectivo');
  const { ejecutar } = useAccionRecepcion({ rpcName: 'recepcion_cambiar_plan' });

  // Tiers activos del tenant (RLS scopea), excluyendo el plan actual.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let req = supabase
        .from('tiers')
        .select('id, nombre, precio_centavos, moneda, tipo')
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

  // Las clases que el socio YA PAGÓ y no usó. Sin esto, recepción cambiaba el plan
  // a ciegas y se las borraba sin enterarse.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('membresias')
        .select('creditos_restantes, tier:tiers(tipo)')
        .eq('usuario_id', socioId)
        // Incluir 'expirada': el backend (gestionar_membresia_socio) sí la mira y
        // bloquea el cambio si tiene créditos. Si acá NO la miramos, la casilla de
        // "confirmar pérdida" no aparece y recepción queda sin forma de confirmar
        // (callejón sin salida para un socio vencido con clases sin usar).
        .in('status', ['activa', 'congelada', 'past_due', 'trialing', 'expirada'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cancelled) return;
      const row = data as { creditos_restantes: number | null; tier: { tipo: string } | null } | null;
      setSaldo(row?.tier ? { creditos: row.creditos_restantes ?? 0, tipo: row.tier.tipo } : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [socioId, isOpen]);

  const tier = tiers.find((t) => t.id === nuevoTierId);

  // La pérdida ocurre al cambiar de TIPO de plan (paquete ↔ mensualidad) teniendo
  // clases sin usar: el socio tiene UNA membresía y las clases sueltas no tienen
  // dónde quedarse. La base rechaza el cambio si nadie lo confirma; acá se muestra
  // ANTES de apretar el botón, que es donde sirve.
  const clasesQueSePierden =
    tier && saldo && saldo.creditos > 0 && saldo.tipo !== tier.tipo ? saldo.creditos : 0;

  const puedeConfirmar =
    motivo.trim().length > 0 &&
    nuevoTierId.length > 0 &&
    (clasesQueSePierden === 0 || aceptaPerdida);

  return (
    <AccionModal
      isOpen={isOpen}
      title="Cambiar de plan"
      description={`Asignas un plan distinto a ${socioNombre}.`}
      variant="info"
      confirmLabel="Cambiar plan"
      canConfirm={puedeConfirmar}
      onConfirm={async () => {
        await ejecutar({
          p_usuario_id: socioId,
          p_nuevo_tier_id: nuevoTierId,
          p_motivo: motivo,
          p_metodo_pago: metodo === '' ? null : metodo,
          p_confirmar_perdida: clasesQueSePierden > 0
        });
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
          onChange={(e) => {
            setNuevoTierId(e.target.value);
            setAceptaPerdida(false);
          }}
        >
          <option value="" disabled>Elige un plan…</option>
          {tiers.map((t) => (
            <option key={t.id} value={t.id}>{t.nombre}</option>
          ))}
        </select>
      </div>

      {clasesQueSePierden > 0 && (
        <div
          style={{
            display: 'flex',
            gap: '10px',
            padding: '12px 14px',
            marginBottom: '12px',
            borderRadius: 'var(--ek-r-card)',
            border: '1px solid var(--sala-error)',
            background: 'var(--sala-surface)'
          }}
        >
          <AlertTriangle
            size={18}
            strokeWidth={2}
            style={{ color: 'var(--sala-error)', flexShrink: 0, marginTop: '1px' }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: '13px', fontWeight: 700, color: 'var(--sala-error)' }}>
              {socioNombre} pierde {clasesQueSePierden}{' '}
              {clasesQueSePierden === 1 ? 'clase que ya pagó' : 'clases que ya pagó'}
            </p>
            <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--sala-text-secondary)', lineHeight: 1.5 }}>
              El plan nuevo es de otro tipo y las clases sueltas no se pueden llevar a él. Si no
              quieres que las pierda, espera a que las use antes de cambiarle el plan.
            </p>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginTop: '10px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              <input
                type="checkbox"
                checked={aceptaPerdida}
                onChange={(e) => setAceptaPerdida(e.target.checked)}
              />
              Entiendo que se pierden y quiero cambiar el plan igual
            </label>
          </div>
        </div>
      )}

      {/* Cambiar de plan no re-cobra inscripción: ya es socio. */}
      {tier && (
        <MetodoPagoField
          value={metodo}
          onChange={setMetodo}
          precioCentavos={tier.precio_centavos ?? 0}
          inscripcionCentavos={0}
          moneda={tier.moneda}
        />
      )}

      <MotivoField
        value={motivo}
        onChange={setMotivo}
        opciones={['Upgrade del cliente', 'Downgrade', 'Cambio de modalidad', 'Cortesía del owner']}
        label="Motivo del cambio"
      />
    </AccionModal>
  );
}
