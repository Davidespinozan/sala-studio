import { useCallback, useEffect, useState } from 'react';
import { Fingerprint, Copy, Check } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useSucursal } from '../providers/SucursalProvider';

interface Lector {
  id: string;
  nombre: string;
  marca: string | null;
  modelo: string | null;
  sucursal_id: string | null;
  activo: boolean;
  ultimo_visto_at: string | null;
}

/** Un lector que no da señales hace más de 10 min está desenchufado o sin internet. */
const VIVO_MS = 10 * 60 * 1000;

function estaVivo(ultimoVisto: string | null): boolean {
  if (!ultimoVisto) return false;
  return Date.now() - new Date(ultimoVisto).getTime() < VIVO_MS;
}

export default function Lectores() {
  const { sucursales, multisede } = useSucursal();
  const [lectores, setLectores] = useState<Lector[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [creando, setCreando] = useState(false);

  // El token en claro existe UNA vez: cuando se crea el lector. Después solo hay
  // hash. Si el gym lo pierde, hay que dar de alta el lector otra vez.
  const [tokenNuevo, setTokenNuevo] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const { data } = await supabase
      .from('lectores_biometricos')
      .select('id, nombre, marca, modelo, sucursal_id, activo, ultimo_visto_at')
      .order('created_at', { ascending: true });
    setLectores((data ?? []) as Lector[]);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}
      >
        <div>
          <p className="ek-eyebrow">LECTORES</p>
          <h1 className="ek-h2">Lector de huella</h1>
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '4px' }}>
            {lectores.length === 0
              ? 'Ninguno todavía'
              : `${lectores.length} ${lectores.length === 1 ? 'lector' : 'lectores'}`}
          </p>
        </div>
        <button onClick={() => setCreando(true)} className="ek-cta">
          + Nuevo lector
        </button>
      </div>

      <div
        style={{
          background: 'var(--sala-primary-light)',
          border: '1px solid var(--sala-border)',
          borderRadius: '12px',
          padding: '12px 16px',
        }}
      >
        <p style={{ fontSize: '13px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.6 }}>
          Con un lector conectado, tus socios entran apoyando el dedo — sin sacar el celular.
          Las huellas se guardan acá, cifradas: si el aparato se rompe, comprás otro y nadie
          tiene que volver a registrarse. Cada socio decide si la da, y puede borrarla cuando
          quiera desde su app.
        </p>
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : lectores.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '40px 20px',
            border: '1px dashed var(--sala-border)',
            borderRadius: 'var(--ek-r-card)',
          }}
        >
          <Fingerprint
            size={32}
            strokeWidth={1.5}
            style={{ color: 'var(--sala-text-tertiary)', marginBottom: '10px' }}
          />
          <p style={{ fontSize: '14px', fontWeight: 600, margin: 0 }}>Todavía no diste de alta ningún lector</p>
          <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '6px 0 0', lineHeight: 1.5 }}>
            Sirve cualquier lector de huella USB. Al darlo de alta te damos una clave para
            pegar en el programa que corre en la compu del mostrador.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {lectores.map((l) => (
            <LectorRow
              key={l.id}
              lector={l}
              sedeNombre={
                multisede ? sucursales.find((s) => s.id === l.sucursal_id)?.nombre ?? 'Todas las sedes' : null
              }
            />
          ))}
        </div>
      )}

      {creando && (
        <NuevoLectorModal
          onClose={() => setCreando(false)}
          onCreado={async (token) => {
            setCreando(false);
            setTokenNuevo(token);
            await refetch();
          }}
        />
      )}

      {tokenNuevo && <TokenModal token={tokenNuevo} onClose={() => setTokenNuevo(null)} />}
    </div>
  );
}

function LectorRow({ lector, sedeNombre }: { lector: Lector; sedeNombre: string | null }) {
  const vivo = estaVivo(lector.ultimo_visto_at);

  return (
    <div
      className="ek-card ek-card--md"
      style={{ display: 'flex', alignItems: 'center', gap: '12px' }}
    >
      <Fingerprint
        size={20}
        strokeWidth={2}
        style={{ color: vivo ? 'var(--sala-primary)' : 'var(--sala-text-tertiary)', flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: '14px', fontWeight: 700 }}>{lector.nombre}</p>
        <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--sala-text-secondary)' }}>
          {[
            [lector.marca, lector.modelo].filter(Boolean).join(' ') || null,
            sedeNombre,
          ]
            .filter(Boolean)
            .join(' · ') || 'Sin datos del aparato'}
        </p>
      </div>
      <span
        style={{
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          padding: '4px 10px',
          borderRadius: '999px',
          whiteSpace: 'nowrap',
          color: vivo ? 'var(--sala-success)' : 'var(--sala-text-tertiary)',
          border: `1px solid ${vivo ? 'var(--sala-success)' : 'var(--sala-border)'}`,
        }}
      >
        {vivo ? '● Conectado' : lector.ultimo_visto_at ? 'Sin señal' : 'Sin conectar'}
      </span>
    </div>
  );
}

function NuevoLectorModal({
  onClose,
  onCreado,
}: {
  onClose: () => void;
  onCreado: (token: string) => Promise<void>;
}) {
  const { sucursales, multisede } = useSucursal();
  const [nombre, setNombre] = useState('');
  const [marca, setMarca] = useState('');
  const [modelo, setModelo] = useState('');
  const [sucursalId, setSucursalId] = useState<string>(multisede ? '' : sucursales[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  async function crear() {
    setGuardando(true);
    setError(null);
    try {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string,
        params?: Record<string, unknown>
      ) => Promise<{ data: { token?: string } | null; error: { message: string } | null }>;

      const { data, error: err } = await rpc('registrar_lector', {
        p_nombre: nombre,
        p_sucursal_id: sucursalId || null,
        p_marca: marca || null,
        p_modelo: modelo || null,
      });
      if (err) throw new Error(err.message.replace(/^[A-Z_]+:\s*/, ''));
      if (!data?.token) throw new Error('No recibimos la clave del lector');
      await onCreado(data.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo dar de alta el lector');
      setGuardando(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <h2 className="ek-h3" style={{ margin: '0 0 4px' }}>Nuevo lector</h2>
      <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>
        Ponele un nombre que diga dónde está. Si tenés dos sedes, el lector solo va a poder
        registrar entradas de la suya.
      </p>

      <Campo label="Nombre" hint='Ej: "Entrada principal"'>
        <input
          className="ek-input"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          placeholder="Entrada principal"
        />
      </Campo>

      {multisede && (
        <Campo label="Sede">
          <select className="ek-input" value={sucursalId} onChange={(e) => setSucursalId(e.target.value)}>
            <option value="">Todas las sedes</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>{s.nombre}</option>
            ))}
          </select>
        </Campo>
      )}

      {/* Marca y modelo son para soporte, no para el sistema: funciona con cualquier
          lector USB. Por eso son opcionales. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <Campo label="Marca (opcional)">
          <input className="ek-input" value={marca} onChange={(e) => setMarca(e.target.value)} />
        </Campo>
        <Campo label="Modelo (opcional)">
          <input className="ek-input" value={modelo} onChange={(e) => setModelo(e.target.value)} />
        </Campo>
      </div>

      {error && (
        <p style={{ fontSize: '12.5px', color: 'var(--sala-error)', margin: '0 0 12px' }}>{error}</p>
      )}

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button className="ek-cta ek-cta--secondary" onClick={onClose}>Cancelar</button>
        <button className="ek-cta" onClick={() => void crear()} disabled={!nombre.trim() || guardando}>
          {guardando ? 'Dando de alta…' : 'Dar de alta'}
        </button>
      </div>
    </Overlay>
  );
}

/** El token se ve UNA vez. Si se cierra sin copiarlo, hay que dar de alta otro lector. */
function TokenModal({ token, onClose }: { token: string; onClose: () => void }) {
  const [copiado, setCopiado] = useState(false);

  return (
    <Overlay onClose={onClose}>
      <h2 className="ek-h3" style={{ margin: '0 0 4px' }}>Listo. Copiá esta clave</h2>
      <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
        Pegala en el programa del lector, en la compu del mostrador.{' '}
        <strong style={{ color: 'var(--sala-error)' }}>
          No la vas a poder volver a ver.
        </strong>{' '}
        Si la perdés, tenés que dar de alta el lector otra vez.
      </p>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '12px',
          marginBottom: '16px',
          borderRadius: 'var(--ek-r-card)',
          border: '1px solid var(--sala-border)',
          background: 'var(--sala-surface)',
        }}
      >
        <code style={{ flex: 1, fontSize: '12px', wordBreak: 'break-all', lineHeight: 1.5 }}>
          {token}
        </code>
        <button
          className="ek-cta ek-cta--secondary"
          style={{ flexShrink: 0, fontSize: '12px', padding: '6px 10px' }}
          onClick={() => {
            void navigator.clipboard.writeText(token);
            setCopiado(true);
          }}
        >
          {copiado ? <Check size={14} /> : <Copy size={14} />}
          {copiado ? ' Copiada' : ' Copiar'}
        </button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="ek-cta" onClick={onClose} disabled={!copiado}>
          Ya la guardé
        </button>
      </div>
    </Overlay>
  );
}

function Campo({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ek-form-field" style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
      <label className="ek-label">{label}</label>
      {children}
      {hint && <p style={{ margin: 0, fontSize: '12px', color: 'var(--sala-text-tertiary)' }}>{hint}</p>}
    </div>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        className="ek-card ek-card--md"
        style={{ width: '100%', maxWidth: '440px', background: 'var(--sala-bg)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
