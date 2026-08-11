import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import type { Clase } from '@member/logic/claseAdapter';
import {
  buscarMiembrosTenant,
  inscribirMiembroManual,
  type MiembroBuscable
} from '@admin/hooks/useInscritosDeClase';

interface Props {
  clase: Clase;
  excludeUsuarioIds: string[];
  onAdded: () => void;
  onClose: () => void;
}

/** Selector de miembro con autocomplete para agregar manualmente a una clase. */
export function AgregarMiembroManualSelector({
  clase,
  excludeUsuarioIds,
  onAdded,
  onClose
}: Props) {
  const tenant = useTenant();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [resultados, setResultados] = useState<MiembroBuscable[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [agregandoId, setAgregandoId] = useState<string | null>(null);
  // Walk-in: la clase ya empezó (o arranca en <30 min) → ofrecer check-in en el
  // mismo paso, prendido por default si ya está corriendo.
  const claseEnVentana = clase.slotInicio.getTime() <= Date.now() + 30 * 60_000;
  const [checkInYa, setCheckInYa] = useState(() => clase.slotInicio.getTime() <= Date.now());

  // Búsqueda con debounce simple
  useEffect(() => {
    if (query.trim().length < 2) {
      setResultados([]);
      return;
    }
    let cancelado = false;
    setBuscando(true);
    const t = setTimeout(async () => {
      const res = await buscarMiembrosTenant(tenant.id, query, excludeUsuarioIds);
      if (!cancelado) {
        setResultados(res);
        setBuscando(false);
      }
    }, 250);
    return () => {
      cancelado = true;
      clearTimeout(t);
    };
  }, [query, tenant.id, excludeUsuarioIds]);

  async function handleAgregar(m: MiembroBuscable) {
    // Clase virtual (aún sin materializar): se activa con su primera reserva.
    // Inscribir manualmente en una virtual lejana es un edge poco común.
    if (!clase.claseId) {
      toast.warning('Esta clase todavía no está activa: se materializa cuando alguien reserva. Prueba en una clase de esta semana.');
      return;
    }
    // Validar acceso por tier (si la clase tiene tiers_permitidos restringidos)
    if (clase.tiersPermitidos && clase.tiersPermitidos.length > 0) {
      if (!m.membresia_tier || !clase.tiersPermitidos.includes(m.membresia_tier)) {
        toast.warning(`El plan de ${m.nombre ?? m.email} no incluye esta sala.`);
        return;
      }
    }
    setAgregandoId(m.id);
    const conCheckIn = checkInYa && claseEnVentana;
    const { error, checkInError } = await inscribirMiembroManual({
      claseId: clase.claseId,
      usuarioId: m.id,
      checkInInmediato: conCheckIn
    });
    setAgregandoId(null);
    if (error) {
      // El error viene de la RPC ya traducido: dice POR QUÉ no se pudo (sin cupo,
      // sin créditos, membresía vencida). Antes esto no se podía saber, porque la
      // inscripción no validaba nada y siempre "funcionaba".
      toast.error(`${m.nombre ?? m.email}: ${error}`);
      return;
    }
    // Toast contextual según anticipación al inicio de la clase
    const nombre = m.nombre ?? m.email;
    const minutosHastaClase = (clase.slotInicio.getTime() - Date.now()) / 60000;
    if (conCheckIn && checkInError) {
      toast.error(`${nombre} quedó inscrito, pero el check-in no pasó: ${checkInError}`);
    } else if (conCheckIn) {
      toast.success(`Listo: ${nombre} inscrito y con check-in.`);
    } else if (minutosHastaClase < 0) {
      toast.info(`Inscribiste a ${nombre} en una clase que ya comenzó.`);
    } else if (minutosHastaClase < 15) {
      toast.info(`Inscribiste a ${nombre} en una clase que arranca en menos de 15 minutos.`);
    } else {
      toast.success(`${nombre} agregado a la clase.`);
    }
    setQuery('');
    setResultados([]);
    onAdded();
  }

  return (
    <div
      style={{
        background: 'var(--sala-bg)',
        border: '1px solid var(--sala-border)',
        borderRadius: '12px',
        padding: '14px'
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: '12px'
        }}
      >
        <p
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--sala-primary)',
            margin: 0
          }}
        >
          Agregar miembro
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar selector"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--sala-text-tertiary)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            padding: '4px 8px',
            fontFamily: 'inherit'
          }}
        >
          <X size={16} strokeWidth={2.25} />
        </button>
      </div>

      <input
        type="search"
        placeholder="Buscar por nombre o email…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
        className="ek-input"
        style={{ marginBottom: '10px' }}
      />

      {/* Walk-in: la clase es de ahorita — inscribir y hacer check-in en un paso */}
      {claseEnVentana && (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '10px',
            padding: '8px 10px',
            borderRadius: '10px',
            background: 'var(--sala-primary-light)',
            fontSize: '12.5px',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          <input type="checkbox" checked={checkInYa} onChange={(e) => setCheckInYa(e.target.checked)} />
          Hacer check-in de una vez (ya está aquí)
        </label>
      )}

      {buscando && (
        <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: 0 }}>
          Buscando…
        </p>
      )}

      {!buscando && query.length >= 2 && resultados.length === 0 && (
        <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: 0 }}>
          Sin coincidencias. Prueba con otro nombre o email.
        </p>
      )}

      {resultados.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '240px', overflowY: 'auto' }}>
          {resultados.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => handleAgregar(m)}
              disabled={agregandoId === m.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '10px 12px',
                background: 'var(--sala-surface)',
                border: '1px solid var(--sala-border)',
                borderRadius: '10px',
                cursor: agregandoId === m.id ? 'not-allowed' : 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
                opacity: agregandoId === m.id ? 0.6 : 1,
                width: '100%'
              }}
            >
              <span
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  background: 'var(--sala-primary)',
                  color: 'var(--sala-text-on-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '13px',
                  fontWeight: 700,
                  flexShrink: 0
                }}
              >
                {(m.nombre ?? m.email).charAt(0).toUpperCase()}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--sala-text-primary)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.nombre ?? m.email}
                </p>
                <p style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.email}
                  {m.membresia_tier && ` · ${m.membresia_tier}`}
                </p>
              </div>
              <span style={{ fontSize: '11px', color: 'var(--sala-primary)', fontWeight: 600 }}>
                {agregandoId === m.id ? '…' : '+ Agregar'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
