import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { CalendarClock, CalendarDays, Users } from 'lucide-react';
import { useReservasHoy } from './hooks/useReservasHoy';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { accesoRevocado } from '@shared/lib/accountStatus';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';
import { AppShell } from '@shared/components/AppShell';
import { TenantGuard } from '@shared/components/TenantGuard';
import { ModoDemoBanner } from '@shared/components/ModoDemoBanner';
import { AppSidebar, type AppNavSection } from '@shared/components/AppSidebar';
import { MapPin } from 'lucide-react';
import { ReceptionSucursalProvider, useReceptionSucursal } from './providers/ReceptionSucursalProvider';

const Scanner = lazy(() => import('./pages/Scanner'));
const Socios = lazy(() => import('./pages/Socios'));
const SocioFicha = lazy(() => import('./pages/SocioFicha'));
const Agenda = lazy(() => import('./pages/Agenda'));

// Nav de RECEPCIÓN — plana (sin secciones colapsables), 3 destinos.
const RECEPCION_SECTIONS: AppNavSection[] = [
  {
    items: [
      { to: '/recepcion', label: 'Hoy', icon: <CalendarClock size={18} /> },
      { to: '/recepcion/agenda', label: 'Agenda', icon: <CalendarDays size={18} /> },
      { to: '/recepcion/socios', label: 'Socios', icon: <Users size={18} /> }
    ]
  }
];

export default function ReceptionLayout() {
  const { authUser, usuario, isLoading, signOut } = useAuth();
  const location = useLocation();
  const toast = useToast();
  const yaCerrado = useRef(false);

  // Acceso retirado (revocado/suspendido/cancelado) → toast + signOut. Igual que
  // MemberLayout: no navegamos a /login mientras `usuario` sigue en cache (haría
  // loop con useRoleRedirect); mostramos loading hasta que el signOut limpie la
  // sesión y caigamos en el Navigate a /login de abajo.
  useEffect(() => {
    if (isLoading || !authUser || !usuario) return;
    if (!accesoRevocado(usuario.status)) return;
    if (yaCerrado.current) return;
    yaCerrado.current = true;
    toast.error('Tu acceso fue revocado. Contacta al administrador.', 8000);
    void signOut();
  }, [authUser, usuario, isLoading, signOut, toast]);

  if (isLoading) return <LoadingScreen />;
  if (!authUser) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!usuario) return <LoadingScreen />;
  if (accesoRevocado(usuario.status)) return <LoadingScreen />;

  if (usuario.rol !== 'recepcionista' && usuario.rol !== 'admin') {
    return <Navigate to="/app" replace />;
  }

  return (
    <ReceptionSucursalProvider>
      <TenantGuard>
        <ModoDemoBanner />
        <DemoBanner vista="Recepción" />
        <AppShell
          roleLabel="RECEPCIÓN"
          sidebar={({ onNavigate }) => (
            <AppSidebar
              sections={RECEPCION_SECTIONS}
              roleLabel="RECEPCIÓN"
              homePath="/recepcion"
              statusSlot={<ReceptionStatus />}
              onNavigate={onNavigate}
            />
          )}
        >
          <main className="adm-main">
            <SedeBar />
            <Suspense fallback={<LoadingScreen />}>
              <Routes>
                <Route path="/" element={<Scanner />} />
                <Route path="/agenda" element={<Agenda />} />
                <Route path="/socios" element={<Socios />} />
                <Route path="/socios/:id" element={<SocioFicha />} />
              </Routes>
            </Suspense>
          </main>
        </AppShell>
      </TenantGuard>
    </ReceptionSucursalProvider>
  );
}

/** Barra de sede de la recepción (solo multisede). Fija para recepción; el
 *  admin puede cambiar de sede para cubrir cualquier mostrador. */
function SedeBar() {
  const { sucursalNombre, sucursalId, sucursales, multisede, puedeCambiar, setSucursalId } =
    useReceptionSucursal();
  if (!multisede) return null;

  if (puedeCambiar) {
    return (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '16px',
          padding: '6px 10px 6px 14px',
          borderRadius: '999px',
          background: 'var(--sala-primary-light)',
          border: '1px solid var(--sala-border)',
          color: 'var(--sala-text-primary)',
          fontSize: '13px',
          fontWeight: 600
        }}
      >
        <MapPin size={14} style={{ color: 'var(--sala-primary)' }} />
        Operando en
        <select
          value={sucursalId ?? ''}
          onChange={(e) => setSucursalId(e.target.value)}
          aria-label="Cambiar de sede"
          style={{
            border: 'none',
            background: 'transparent',
            font: 'inherit',
            fontWeight: 700,
            color: 'var(--sala-primary)',
            cursor: 'pointer',
            padding: '0 2px'
          }}
        >
          {sucursales.map((s) => (
            <option key={s.id} value={s.id}>{s.nombre}</option>
          ))}
        </select>
      </div>
    );
  }

  if (!sucursalNombre) return null;
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '7px',
        marginBottom: '16px',
        padding: '7px 14px',
        borderRadius: '999px',
        background: 'var(--sala-primary-light)',
        border: '1px solid var(--sala-border)',
        color: 'var(--sala-text-primary)',
        fontSize: '13px',
        fontWeight: 600
      }}
    >
      <MapPin size={14} style={{ color: 'var(--sala-primary)' }} />
      Operando en {sucursalNombre}
    </div>
  );
}

/** Bloque discreto del sidebar: estado del sistema (en línea + hora) + actividad
 *  del día (check-ins / reservas). Indicadores de "centro de operaciones". */
function ReceptionStatus() {
  const { reservas } = useReservasHoy();
  const checkins = reservas.filter((r) => r.status === 'completada').length;
  const total = reservas.filter((r) => r.status !== 'cancelada').length;
  const [hora, setHora] = useState(() =>
    new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })
  );
  useEffect(() => {
    const id = setInterval(
      () => setHora(new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })),
      30000
    );
    return () => clearInterval(id);
  }, []);

  const num = { fontFamily: 'var(--ek-font-display)', fontSize: '18px', fontWeight: 700, color: 'rgba(255,255,255,0.95)', lineHeight: 1 } as const;
  const cap = { fontSize: '9px', letterSpacing: '0.07em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)', marginTop: '3px' } as const;

  return (
    <div style={{ margin: '0 0 14px', padding: '12px', borderRadius: '12px', background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.10)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#34d399', boxShadow: '0 0 0 3px rgba(52,211,153,0.20)', flexShrink: 0 }} />
        <span style={{ fontSize: '11px', fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>Sistema en línea</span>
        <span style={{ marginLeft: 'auto', fontSize: '11px', fontVariantNumeric: 'tabular-nums', color: 'rgba(255,255,255,0.55)' }}>{hora}</span>
      </div>
      <div style={{ display: 'flex', gap: '18px' }}>
        <div>
          <div style={num}>{checkins}</div>
          <div style={cap}>check-ins</div>
        </div>
        <div>
          <div style={num}>{total}</div>
          <div style={cap}>reservas hoy</div>
        </div>
      </div>
    </div>
  );
}
