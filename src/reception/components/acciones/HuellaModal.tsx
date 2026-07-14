import { useEffect, useState } from 'react';
import { Fingerprint, AlertTriangle } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { AccionModal } from '@shared/components/AccionModal';
import { DEDOS, nombreDedo } from '@shared/lib/dedos';
import { useHuellasSocio } from '@shared/hooks/useHuellasSocio';
import { translateActionError } from '../../lib/traducirErrorAccion';

interface Props {
  socioId: string;
  socioNombre: string;
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

/** Cada cuánto le preguntamos a la base si el socio ya apoyó el dedo. */
const POLL_MS = 1500;
/** Lo mismo que dura la "toma" en la base (5 min). Después se vence sola. */
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Registrar la huella de un socio desde el mostrador.
 *
 * El navegador NO puede leer el lector USB — ningún navegador expone sensores
 * biométricos. Así que esta pantalla no captura nada: abre una "toma" en la base,
 * y el agente que corre en la compu del mostrador la levanta, le pide el dedo al
 * socio y la cierra. Nosotros nos quedamos mirando hasta que aparece la huella.
 *
 * Por eso la pantalla tiene dos momentos: elegir el dedo (+ consentimiento), y
 * después esperar a que el socio apoye.
 */
export function HuellaModal({ socioId, socioNombre, isOpen, onClose, onDone }: Props) {
  const { huellas, refetch: refetchHuellas } = useHuellasSocio(socioId);
  const [dedo, setDedo] = useState<string>('der_indice');
  const [consiente, setConsiente] = useState(false);
  const [esperando, setEsperando] = useState(false);
  const [hayLector, setHayLector] = useState<boolean | null>(null);
  const [revocando, setRevocando] = useState<string | null>(null);
  const [errorRevocar, setErrorRevocar] = useState<string | null>(null);

  // Sin un lector dado de alta, esto no puede funcionar y más vale decirlo antes
  // de que la recepcionista le pida el dedo al socio para nada.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      const { count } = await supabase
        .from('lectores_biometricos')
        .select('id', { count: 'exact', head: true })
        .eq('activo', true);
      if (!cancelled) setHayLector((count ?? 0) > 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setEsperando(false);
      setConsiente(false);
      setErrorRevocar(null);
    }
  }, [isOpen]);

  const dedosLibres = DEDOS.filter((d) => !huellas.some((h) => h.dedo === d.value));
  const lleno = huellas.length >= 2;

  // El dedo elegido puede quedar ocupado si se registró otro mientras el modal
  // estaba abierto. Lo reacomodamos en vez de dejar que la base tire el error.
  useEffect(() => {
    if (dedosLibres.length > 0 && !dedosLibres.some((d) => d.value === dedo)) {
      setDedo(dedosLibres[0].value);
    }
  }, [dedosLibres, dedo]);

  async function tomarHuella() {
    const rpc = supabase.rpc.bind(supabase) as unknown as (
      fn: string,
      params?: Record<string, unknown>
    ) => Promise<{ error: { message: string } | null }>;

    const { error } = await rpc('iniciar_enrolamiento_huella', {
      p_usuario_id: socioId,
      p_dedo: dedo,
      p_consentimiento: consiente,
    });
    if (error) throw new Error(translateActionError(error));

    // Desde acá el que trabaja es el lector. Nosotros miramos.
    setEsperando(true);
    const hasta = Date.now() + TIMEOUT_MS;

    while (Date.now() < hasta) {
      await new Promise((r) => setTimeout(r, POLL_MS));

      const { data } = await supabase
        .from('credenciales_biometricas')
        .select('id')
        .eq('usuario_id', socioId)
        .eq('dedo', dedo)
        .is('revocada_at', null)
        .maybeSingle();

      if (data) {
        await refetchHuellas();
        await onDone();
        setEsperando(false);
        return;
      }
    }

    setEsperando(false);
    throw new Error(
      'El socio no apoyó el dedo a tiempo y la toma se venció. Revisá que el lector esté encendido y volvé a intentar.'
    );
  }

  async function revocar(dedoARevocar: string) {
    setRevocando(dedoARevocar);
    setErrorRevocar(null);
    try {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string,
        params?: Record<string, unknown>
      ) => Promise<{ error: { message: string } | null }>;

      const { error } = await rpc('revocar_huella_socio', {
        p_usuario_id: socioId,
        p_dedo: dedoARevocar,
      });
      if (error) throw new Error(translateActionError(error));
      await refetchHuellas();
      await onDone();
    } catch (e) {
      setErrorRevocar(e instanceof Error ? e.message : 'No se pudo quitar la huella');
    } finally {
      setRevocando(null);
    }
  }

  return (
    <AccionModal
      isOpen={isOpen}
      title="Huella del socio"
      description={`Con la huella, ${socioNombre} entra sin sacar el celular.`}
      variant="info"
      confirmLabel={esperando ? 'Esperando el dedo…' : 'Tomar huella'}
      canConfirm={hayLector === true && !lleno && consiente && !esperando}
      onConfirm={tomarHuella}
      onClose={onClose}
    >
      {hayLector === false && (
        <Aviso>
          Este gimnasio todavía no tiene ningún lector dado de alta. Pedile al dueño que lo
          registre en <strong>Admin → Lectores</strong> antes de tomar huellas.
        </Aviso>
      )}

      {/* Lo que YA tiene registrado. Sin esto, recepción vuelve a pedirle el dedo
          a alguien que ya lo dio. */}
      {huellas.length > 0 && (
        <div style={{ marginBottom: '14px' }}>
          <p className="ek-label" style={{ marginBottom: '6px' }}>Huellas registradas</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {huellas.map((h) => (
              <div
                key={h.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 10px',
                  borderRadius: 'var(--ek-r-card)',
                  border: '1px solid var(--sala-border)',
                }}
              >
                <Fingerprint size={16} strokeWidth={2} style={{ color: 'var(--sala-primary)' }} />
                <span style={{ flex: 1, fontSize: '13px', fontWeight: 600 }}>{nombreDedo(h.dedo)}</span>
                <button
                  type="button"
                  onClick={() => void revocar(h.dedo)}
                  disabled={revocando === h.dedo}
                  className="ek-cta ek-cta--secondary"
                  style={{ fontSize: '11px', padding: '4px 10px' }}
                >
                  {revocando === h.dedo ? 'Quitando…' : 'Quitar'}
                </button>
              </div>
            ))}
          </div>
          {errorRevocar && (
            <p style={{ margin: '8px 0 0', fontSize: '12px', color: 'var(--sala-error)' }}>
              {errorRevocar}
            </p>
          )}
        </div>
      )}

      {esperando ? (
        <div
          style={{
            display: 'flex',
            gap: '10px',
            padding: '14px',
            borderRadius: 'var(--ek-r-card)',
            border: '1px solid var(--sala-primary)',
            background: 'var(--sala-primary-light)',
          }}
        >
          <Fingerprint
            size={20}
            strokeWidth={2}
            style={{ color: 'var(--sala-primary)', flexShrink: 0, marginTop: '1px' }}
          />
          <div>
            <p style={{ margin: 0, fontSize: '13px', fontWeight: 700 }}>
              Pedile a {socioNombre} que apoye el {nombreDedo(dedo).toLowerCase()} en el lector
            </p>
            <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--sala-text-secondary)', lineHeight: 1.5 }}>
              El lector se lo va a pedir varias veces. Esta pantalla se cierra sola cuando la
              huella queda registrada.
            </p>
          </div>
        </div>
      ) : lleno ? (
        <Aviso>
          {socioNombre} ya tiene dos dedos registrados, que es el máximo. Si querés cambiar uno,
          quitalo primero.
        </Aviso>
      ) : (
        <>
          <div className="ek-form-field" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
            <label className="ek-label" htmlFor="huella-dedo">¿Qué dedo?</label>
            <select
              id="huella-dedo"
              className="ek-input"
              value={dedo}
              onChange={(e) => setDedo(e.target.value)}
            >
              {dedosLibres.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
            {huellas.length === 1 && (
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--sala-text-secondary)' }}>
                Un segundo dedo es buena idea: si se corta o se venda el primero, sigue entrando
                sin pasar por el mostrador.
              </p>
            )}
          </div>

          {/* Sin esto la base rechaza la toma. Y con razón: la huella es un dato
              sensible y el socio tiene que saber qué se le está guardando. */}
          <label
            style={{
              display: 'flex',
              gap: '8px',
              padding: '12px',
              borderRadius: 'var(--ek-r-card)',
              border: '1px solid var(--sala-border)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={consiente}
              onChange={(e) => setConsiente(e.target.checked)}
              style={{ marginTop: '2px' }}
            />
            <span style={{ fontSize: '12.5px', lineHeight: 1.5 }}>
              <strong>{socioNombre} acepta</strong> que el gimnasio guarde su huella para
              entrar a sus clases. Se la puede dar de baja cuando quiera, desde su app o
              pidiéndolo acá.
            </span>
          </label>
        </>
      )}
    </AccionModal>
  );
}

function Aviso({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: '10px',
        padding: '12px',
        marginBottom: '12px',
        borderRadius: 'var(--ek-r-card)',
        border: '1px solid var(--sala-border)',
        background: 'var(--sala-surface)',
      }}
    >
      <AlertTriangle
        size={16}
        strokeWidth={2}
        style={{ color: 'var(--sala-warning)', flexShrink: 0, marginTop: '2px' }}
      />
      <p style={{ margin: 0, fontSize: '12.5px', lineHeight: 1.5 }}>{children}</p>
    </div>
  );
}
