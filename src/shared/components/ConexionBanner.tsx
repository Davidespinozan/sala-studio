import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

/**
 * Banner global "sin conexión": escucha los eventos online/offline del navegador
 * y avisa cuando se cae la red. Evita que las acciones fallen en silencio (una
 * query/mutación sin red dejaba pantallas vacías sin explicación).
 */
export default function ConexionBanner() {
  const [offline, setOffline] = useState(
    typeof navigator !== 'undefined' && navigator.onLine === false
  );

  useEffect(() => {
    const goOnline = () => setOffline(false);
    const goOffline = () => setOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 300,
        background: 'var(--sala-warning, #b8860b)',
        color: '#1a1f1c',
        padding: 'calc(env(safe-area-inset-top, 0px) + 8px) 16px 8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        fontSize: '13px',
        fontWeight: 600,
        boxShadow: '0 2px 12px rgba(0,0,0,0.18)'
      }}
    >
      <WifiOff size={15} strokeWidth={2.25} aria-hidden="true" />
      Sin conexión. Algunas acciones no estarán disponibles hasta que vuelva la red.
    </div>
  );
}
