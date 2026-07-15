import { useSucursal, TODAS_SEDES } from '../providers/SucursalProvider';

/**
 * Barra global de sucursal. Se muestra arriba del contenido del admin.
 * Gestión (Salas, Instructores, Horarios, Agenda) trabaja sobre la sede
 * elegida; "Todas las sedes" agrega los reportes/caja al gimnasio entero (y
 * la gestión sigue en la última sede real elegida). Para tenants de una sola
 * sucursal queda oculta — el scoping es transparente.
 */
export function SucursalSelectorBar() {
  const { sucursales, sucursalId, esTodas, setSucursalActivaId, multisede } = useSucursal();

  if (!multisede) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '12px 16px',
        borderBottom: '1px solid var(--sala-border-strong)',
        background: 'var(--sala-surface)'
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--sala-primary)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
        <circle cx="12" cy="10" r="3" />
      </svg>
      <label
        htmlFor="sucursal-selector"
        className="ek-eyebrow"
        style={{ fontSize: '10px', color: 'var(--sala-text-tertiary)' }}
      >
        Sucursal
      </label>
      <select
        id="sucursal-selector"
        value={esTodas ? TODAS_SEDES : sucursalId ?? ''}
        onChange={(e) => setSucursalActivaId(e.target.value)}
        style={{
          appearance: 'auto',
          padding: '6px 10px',
          fontSize: '13px',
          fontWeight: 600,
          fontFamily: 'inherit',
          color: 'var(--sala-text-primary)',
          background: 'var(--sala-bg)',
          border: '1px solid var(--sala-border-strong)',
          borderRadius: '8px',
          cursor: 'pointer',
          minWidth: '180px'
        }}
      >
        {sucursales.map((s) => (
          <option key={s.id} value={s.id}>
            {s.nombre}
          </option>
        ))}
        {/* Agrega los reportes y la caja al gimnasio entero. */}
        <option value={TODAS_SEDES}>Todas las sedes</option>
      </select>
    </div>
  );
}
