import { useCallback, useState } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { backendPost } from '@shared/lib/backend';
import { ReservasHoyView } from '../components/ReservasHoyView';
import { CheckInDetail } from '../components/CheckInDetail';
import { CameraModal } from '../components/CameraModal';
import { useScannerHID } from '../hooks/useScannerHID';

function capitalizarNombre(s: string | undefined | null): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

interface VerifyResponse {
  success: boolean;
  data?: {
    reserva: any;
    miembro: any;
    recurso: any;
    stats?: { check_ins_hoy: number; check_ins_semana: number };
  };
  error?: string;
  message?: string;
}

type DetailState =
  | { kind: 'none' }
  | { kind: 'success'; data: VerifyResponse['data'] }
  | { kind: 'error'; message: string };

export default function Scanner() {
  const { usuario, signOut } = useAuth();
  const [detail, setDetail] = useState<DetailState>({ kind: 'none' });
  const [cameraOpen, setCameraOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const handleQRPayload = useCallback(async (qrPayload: string) => {
    try {
      const res = await backendPost<VerifyResponse>('qr-verify', { qr_payload: qrPayload });
      if (res.success && res.data) {
        setDetail({ kind: 'success', data: res.data });
      } else {
        setDetail({ kind: 'error', message: res.message ?? 'QR no válido' });
      }
      setRefreshTick((t) => t + 1);
    } catch (e) {
      setDetail({ kind: 'error', message: e instanceof Error ? e.message : 'Error verificando QR' });
    }
  }, []);

  // Listener de scanner HID. Se pausa cuando hay modales abiertos.
  useScannerHID(handleQRPayload, detail.kind === 'none' && !cameraOpen);

  const closeDetail = () => setDetail({ kind: 'none' });
  const handleManualCheckIn = (data: VerifyResponse['data']) => {
    setDetail({ kind: 'success', data });
    setRefreshTick((t) => t + 1);
  };

  const nombreUsuarioFormat = capitalizarNombre(usuario?.nombre) || usuario?.email || '';

  return (
    <div className="rec-shell">
      <header className="ek-header-glass">
        <div
          className="ek-header-inner"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div>
            <p
              className="ek-eyebrow ek-eyebrow--mustard"
              style={{ marginBottom: '4px', fontSize: '10px' }}
            >
              RECEPCIÓN
            </p>
            <p
              style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '18px',
                fontWeight: 700,
                letterSpacing: '-0.03em',
                margin: 0,
                color: 'var(--ek-mustard)'
              }}
            >
              EKKO Studio
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '13px', color: 'var(--ek-ink-muted)' }}>
              {nombreUsuarioFormat}
            </span>
            <button
              onClick={signOut}
              className="ek-icon-btn"
              style={{ width: 'auto', padding: '8px 14px', fontSize: '13px' }}
            >
              Salir
            </button>
          </div>
        </div>
      </header>

      <div className="rec-main">
        <ReservasHoyView
          key={refreshTick}
          onManualCheckInSuccess={handleManualCheckIn}
        />
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
            '0 8px 32px rgba(229, 184, 41, 0.35), 0 4px 12px rgba(0, 0, 0, 0.4)',
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
            '0 12px 40px rgba(229, 184, 41, 0.45), 0 6px 16px rgba(0, 0, 0, 0.5)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'scale(1)';
          e.currentTarget.style.boxShadow =
            '0 8px 32px rgba(229, 184, 41, 0.35), 0 4px 12px rgba(0, 0, 0, 0.4)';
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
            errorMessage={detail.kind === 'error' ? detail.message : undefined}
            onClose={closeDetail}
          />
        </div>
      )}
    </div>
  );
}
