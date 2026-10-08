import { useCallback, useState } from 'react';
import { backendPost } from '@shared/lib/backend';
import { ReservasHoyView } from '../components/ReservasHoyView';
import { CheckInDetail } from '../components/CheckInDetail';
import { CameraModal } from '../components/CameraModal';
import { useScannerHID } from '../hooks/useScannerHID';
import { useHuellaCheckins, type HuellaCheckinData } from '../hooks/useHuellaCheckins';
import { useLectorEstado } from '../hooks/useLectorEstado';
import { playCheckInSuccess, playCheckInError } from '../lib/checkInFeedback';
import CentroPendientes from '@admin/components/CentroPendientes';
import { useReceptionSucursal } from '../providers/ReceptionSucursalProvider';
import { CumpleanosCard } from '@shared/components/CumpleanosCard';
import { PoweredBySala } from '@shared/components/PoweredBySala';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { getTenantTimezone } from '@shared/lib/timezone';
import { saludoPorHora, nombreDePila } from '@shared/lib/saludo';
import { formatInTimeZone } from 'date-fns-tz';
import { es } from 'date-fns/locale';

interface VerifyResponse {
  success: boolean;
  data?: {
    reserva: any;
    miembro: any;
    recurso: any;
    stats?: { check_ins_hoy: number; check_ins_semana: number };
    /** 'ok' | 'vencida' | 'congelada' | 'sin_membresia' — lo calcula el RPC. */
    membresia_estado?: string;
  };
  error?: string;
  message?: string;
}

type DetailState =
  | { kind: 'none' }
  | { kind: 'success'; data: VerifyResponse['data'] }
  | { kind: 'error'; message: string };

/** Estado del lector de huella, a la vista de recepción (son quienes lo usan). */
/** Estado del lector de huella. Vive dentro del hero oscuro: pastilla translúcida
 *  con el punto de color (verde responde / rojo sin señal). */
function LectorBadge() {
  const estado = useLectorEstado();
  if (estado === 'sin_lector') return null; // sin lector dado de alta → no estorbar
  const conectado = estado === 'conectado';
  return (
    <div
      title={conectado ? 'El lector de huella está respondiendo.' : 'El lector no da señal. Revisa que el agente esté abierto y el lector conectado.'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '7px',
        padding: '6px 12px', borderRadius: '999px', whiteSpace: 'nowrap',
        fontSize: '12px', fontWeight: 700,
        background: 'rgba(255, 255, 255, 0.10)',
        color: '#fff',
        border: '1px solid rgba(255, 255, 255, 0.18)'
      }}
    >
      <span
        style={{
          width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
          background: conectado ? '#34d399' : '#f87171',
          boxShadow: `0 0 0 3px ${conectado ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)'}`
        }}
      />
      {conectado ? 'Lector conectado' : 'Lector sin señal'}
    </div>
  );
}

export default function Scanner() {
  const [detail, setDetail] = useState<DetailState>({ kind: 'none' });
  const [cameraOpen, setCameraOpen] = useState(false);
  const [agendaModalOpen, setAgendaModalOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const handleQRPayload = useCallback(async (qrPayload: string) => {
    try {
      const res = await backendPost<VerifyResponse>('qr-verify', { qr_payload: qrPayload });
      if (res.success && res.data) {
        playCheckInSuccess();
        setDetail({ kind: 'success', data: res.data });
      } else {
        playCheckInError();
        setDetail({ kind: 'error', message: res.message ?? 'QR no válido' });
      }
      setRefreshTick((t) => t + 1);
    } catch (e) {
      playCheckInError();
      setDetail({ kind: 'error', message: e instanceof Error ? e.message : 'Error verificando QR' });
    }
  }, []);

  // Listener de scanner HID. Se pausa cuando hay modales abiertos (el overlay de
  // check-in del Scanner, la cámara, o un modal de la agenda en ReservasHoyView).
  useScannerHID(handleQRPayload, detail.kind === 'none' && !cameraOpen && !agendaModalOpen);

  // Check-in por HUELLA: el agente lo marca en la base y la pantalla lo detecta y
  // muestra al socio (misma pantalla que el QR), sin que recepción toque nada.
  const handleHuellaCheckIn = useCallback((data: HuellaCheckinData) => {
    playCheckInSuccess();
    setDetail({ kind: 'success', data });
    setRefreshTick((t) => t + 1);
  }, []);
  useHuellaCheckins(handleHuellaCheckIn, detail.kind === 'none' && !cameraOpen && !agendaModalOpen);

  const closeDetail = () => setDetail({ kind: 'none' });
  const handleManualCheckIn = (data: VerifyResponse['data']) => {
    setDetail({ kind: 'success', data });
    setRefreshTick((t) => t + 1);
  };

  return (
    <div className="rec-shell">
      <div className="rec-main">
        <HeroHoy />

        <PendientesSede />

        <CumpleanosCard linkBase="/recepcion/socios" />

        <ReservasHoyView
          key={refreshTick}
          onManualCheckInSuccess={handleManualCheckIn}
          onModalOpenChange={setAgendaModalOpen}
        />
        <PoweredBySala />
      </div>

      <button
        onClick={() => setCameraOpen(true)}
        aria-label="Abrir cámara para escanear QR"
        style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          width: '64px',
          height: '64px',
          borderRadius: '50%',
          background: 'var(--ek-mustard)',
          color: 'var(--ek-bg)',
          border: 'none',
          boxShadow:
            '0 8px 32px var(--sala-primary-glow), 0 4px 12px rgba(0, 0, 0, 0.4)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
          transition: 'transform 0.2s ease, box-shadow 0.2s ease'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'scale(1.05)';
          e.currentTarget.style.boxShadow =
            '0 12px 40px var(--sala-primary-glow-strong), 0 6px 16px rgba(0, 0, 0, 0.5)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'scale(1)';
          e.currentTarget.style.boxShadow =
            '0 8px 32px var(--sala-primary-glow), 0 4px 12px rgba(0, 0, 0, 0.4)';
        }}
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </button>

      {cameraOpen && (
        <CameraModal
          onClose={() => setCameraOpen(false)}
          onScan={(payload) => {
            setCameraOpen(false);
            handleQRPayload(payload);
          }}
        />
      )}

      {detail.kind !== 'none' && (
        <div className="rec-detail-backdrop">
          <CheckInDetail
            kind={detail.kind}
            miembro={detail.kind === 'success' ? detail.data?.miembro : undefined}
            recurso={detail.kind === 'success' ? detail.data?.recurso : undefined}
            reserva={detail.kind === 'success' ? detail.data?.reserva : undefined}
            stats={detail.kind === 'success' ? detail.data?.stats : undefined}
            membresiaEstado={
              detail.kind === 'success'
                ? (detail.data?.membresia_estado as 'ok' | 'vencida' | 'congelada' | 'sin_membresia' | undefined)
                : undefined
            }
            errorMessage={detail.kind === 'error' ? detail.message : undefined}
            onClose={closeDetail}
          />
        </div>
      )}
    </div>
  );
}

/** Cabecera de Hoy: mismo hero de marca que el dashboard admin. Saludo por hora
 *  del GYM + nombre de quien atiende + fecha, y el estado del lector a la derecha. */
function HeroHoy() {
  const { usuario } = useAuth();
  const tenant = useTenant();
  const tz = getTenantTimezone(tenant);
  const saludo = saludoPorHora(tz);
  const nombre = nombreDePila(usuario?.nombre);
  const fecha = formatInTimeZone(new Date(), tz, "EEEE d 'de' MMMM", { locale: es });
  return (
    <div className="adm-hero" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px 16px', flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        <p className="adm-hero-eyebrow">Recepción · {fecha}</p>
        <h1 className="adm-hero-title">Hoy en {tenant.nombre || 'tu gym'}</h1>
        <p className="adm-hero-subtitle" style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
          {saludo.texto}{nombre ? `, ${nombre}` : ''}
          <saludo.Icon size={17} strokeWidth={2.25} />
        </p>
      </div>
      <LectorBadge />
    </div>
  );
}

/** Apartado "Pendientes" (el mismo del admin) con los conteos de esta sede. */
function PendientesSede() {
  const { sucursalId, multisede } = useReceptionSucursal();
  return <CentroPendientes base="recepcion" sucursalId={multisede ? sucursalId : null} />;
}
