import { useState } from 'react';
import { MapPin, ChevronDown, Check } from 'lucide-react';
import { useMemberSucursal } from '../providers/MemberSucursalProvider';

/**
 * Selector de sede para el socio. Sólo se muestra con 2+ sucursales
 * (multisede). Cambiar de sede filtra clases/salas/instructores y persiste la
 * preferencia local (no toca la membresía, que sirve en cualquier sede).
 */
export function SucursalSwitcher() {
  const { sucursales, sucursalActiva, setSucursalActivaId, multisede } = useMemberSucursal();
  const [open, setOpen] = useState(false);

  if (!multisede || !sucursalActiva) return null;

  return (
    <div style={{ padding: '10px 16px 0', display: 'flex' }}>
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '8px 14px',
          borderRadius: '999px',
          border: '1px solid var(--sala-border)',
          background: 'var(--sala-surface)',
          color: 'var(--sala-text-primary)',
          fontSize: '13px',
          fontWeight: 600,
          cursor: 'pointer',
          maxWidth: '70vw'
        }}
      >
        <MapPin size={14} strokeWidth={2.25} style={{ color: 'var(--sala-primary)', flexShrink: 0 }} />
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sucursalActiva.nombre}
        </span>
        <ChevronDown size={14} strokeWidth={2.25} style={{ flexShrink: 0, opacity: 0.6 }} />
      </button>

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
            aria-hidden="true"
          />
          <div
            role="menu"
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              zIndex: 41,
              minWidth: '200px',
              background: 'var(--sala-surface)',
              border: '1px solid var(--sala-border)',
              borderRadius: '14px',
              boxShadow: '0 14px 36px rgba(10, 15, 12, 0.18)',
              padding: '6px',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px'
            }}
          >
            {sucursales.map((s) => {
              const activa = s.id === sucursalActiva.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSucursalActivaId(s.id);
                    setOpen(false);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                    padding: '10px 12px',
                    borderRadius: '10px',
                    border: 'none',
                    background: activa ? 'var(--sala-primary-light)' : 'transparent',
                    color: 'var(--sala-text-primary)',
                    fontSize: '14px',
                    fontWeight: activa ? 600 : 500,
                    cursor: 'pointer',
                    textAlign: 'left',
                    width: '100%'
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.nombre}
                    </span>
                    {s.direccion && (
                      <span style={{ display: 'block', fontSize: '11px', color: 'var(--sala-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.direccion}
                      </span>
                    )}
                  </span>
                  {activa && <Check size={16} strokeWidth={2.5} style={{ color: 'var(--sala-primary)', flexShrink: 0 }} />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
    </div>
  );
}
