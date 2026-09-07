import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { AccionModal } from '@shared/components/AccionModal';
import { MotivoField } from '@shared/components/MotivoField';
import { MetodoPagoField, type MetodoPago } from './MetodoPagoField';
import { translateActionError } from '@reception/lib/traducirErrorAccion';

interface Props {
  socioId: string;
  socioNombre: string;
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

/**
 * Cobra la inscripción a criterio de recepción, aunque el socio ya figure como
 * existente (la regla normal solo la ofrece al socio nuevo). Método de dinero →
 * la registra en la Caja (RPC cobrar_inscripcion_socio); "Cortesía" → la exenta
 * sin cobrar (RPC exentar_inscripcion_socio). No permite doble cobro.
 */
export function CobrarInscripcionModal({ socioId, socioNombre, isOpen, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const [metodo, setMetodo] = useState<MetodoPago | ''>('efectivo');
  const [inscripcionCentavos, setInscripcionCentavos] = useState(0);
  const [moneda, setMoneda] = useState('MXN');
  const [yaPagada, setYaPagada] = useState(false);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const [{ data: u, error: uErr }, { data: mem }] = await Promise.all([
        supabase.from('usuarios').select('inscripcion_pagada_at').eq('id', socioId).maybeSingle(),
        supabase
          .from('membresias')
          .select('tier:tiers(inscripcion_centavos, moneda)')
          .eq('usuario_id', socioId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      ]);
      if (cancel) return;
      // El fallo de leer inscripcion_pagada_at es MUDO si la columna no está en el
      // GRANT (ver trampa de columnas de usuarios) — por eso se loguea.
      if (uErr) console.error('[CobrarInscripcion] inscripcion_pagada_at:', uErr.message);
      setYaPagada((u as { inscripcion_pagada_at?: string | null } | null)?.inscripcion_pagada_at != null);
      const t = (mem as { tier?: { inscripcion_centavos?: number; moneda?: string } | null } | null)?.tier;
      setInscripcionCentavos(t?.inscripcion_centavos ?? 0);
      setMoneda(t?.moneda ?? 'MXN');
      setCargando(false);
    })();
    return () => {
      cancel = true;
    };
  }, [socioId]);

  const esCortesia = metodo === 'cortesia';
  const canConfirm =
    !yaPagada && !cargando && metodo !== '' && (esCortesia || inscripcionCentavos > 0);

  return (
    <AccionModal
      isOpen={isOpen}
      title="Cobrar inscripción"
      description={`Registras la inscripción de ${socioNombre}.`}
      variant="info"
      confirmLabel={esCortesia ? 'Exentar inscripción' : 'Cobrar inscripción'}
      canConfirm={canConfirm}
      onConfirm={async () => {
        const rpc = supabase.rpc.bind(supabase) as unknown as (
          name: string,
          args: Record<string, unknown>
        ) => Promise<{ data: unknown; error: { message: string } | null }>;

        if (esCortesia) {
          // Cortesía = marcar como pagada sin cobrar (mismo RPC que exentar).
          const { error } = await rpc('exentar_inscripcion_socio', { p_usuario_id: socioId });
          if (error) throw new Error(translateActionError(error.message));
        } else {
          const { error } = await rpc('cobrar_inscripcion_socio', {
            p_usuario_id: socioId,
            p_metodo: metodo,
            p_monto_centavos: null,
            p_motivo: motivo.trim() || null
          });
          if (error) throw new Error(translateActionError(error.message));
        }
        await onDone();
      }}
      onClose={onClose}
    >
      {cargando ? (
        <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)' }}>Cargando…</p>
      ) : yaPagada ? (
        <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', lineHeight: 1.5 }}>
          Este socio ya tiene la inscripción registrada; no se puede cobrar de nuevo.
        </p>
      ) : !esCortesia && inscripcionCentavos <= 0 ? (
        <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', lineHeight: 1.5 }}>
          Su plan no tiene inscripción configurada. Ponle un monto en el plan, o márcala como cortesía.
        </p>
      ) : (
        <>
          <MetodoPagoField
            value={metodo}
            onChange={setMetodo}
            precioCentavos={0}
            inscripcionCentavos={inscripcionCentavos}
            moneda={moneda}
          />
          {!esCortesia && (
            <MotivoField
              value={motivo}
              onChange={setMotivo}
              opciones={['Inscripción en efectivo', 'Inscripción con terminal', 'Inscripción por transferencia']}
              label="Motivo (opcional)"
            />
          )}
          {esCortesia && (
            <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px', lineHeight: 1.45 }}>
              Se marca como pagada <strong>sin cobrar</strong> (cortesía) — no entra dinero a la Caja.
            </p>
          )}
        </>
      )}
    </AccionModal>
  );
}
