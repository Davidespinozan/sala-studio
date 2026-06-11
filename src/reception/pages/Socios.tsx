import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, ChevronRight } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { TenantLogo } from '@shared/components/TenantLogo';
import { useSocios, type SocioListItem } from '../hooks/useSocios';

function iniciales(nombre: string | null): string {
  const t = (nombre ?? '').trim().split(/\s+/).filter(Boolean);
  if (!t.length) return '?';
  return (t[0][0] + (t[1]?.[0] ?? '')).toUpperCase();
}

export default function Socios() {
  const { signOut, usuario } = useAuth();
  const [q, setQ] = useState('');
  const { socios, isLoading } = useSocios(q);

  return (
    <div className="ek-page">
      <header className="ek-header-glass">
        <div
          className="ek-header-inner"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '4px', fontSize: '10px' }}>
              RECEPCIÓN
            </p>
            <TenantLogo variant="completo" height={36} fallbackFontSize={28} showSuffix />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '13px', color: 'var(--ek-ink-muted)' }}>
              {usuario?.nombre ?? ''}
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

      <div style={{ maxWidth: '640px', margin: '0 auto', padding: '20px' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>SOCIOS</p>

        {/* Buscador */}
        <div style={{ position: 'relative', marginBottom: '18px' }}>
          <Search
            size={18}
            style={{
              position: 'absolute',
              left: '14px',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--sala-text-tertiary)',
              pointerEvents: 'none',
            }}
          />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="ek-input"
            placeholder="Buscar por nombre o teléfono…"
            autoFocus
            style={{ paddingLeft: '42px', minHeight: '48px', fontSize: '15px' }}
          />
        </div>

        {isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="ek-skeleton" style={{ height: '64px', borderRadius: 'var(--ek-r-md)' }} />
            ))}
          </div>
        ) : socios.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--sala-text-tertiary)' }}>
            <Search size={30} strokeWidth={1.5} style={{ marginBottom: '10px' }} />
            <p className="ek-body" style={{ margin: 0, color: 'var(--sala-text-secondary)', fontWeight: 600 }}>
              {q.trim() ? 'Sin resultados' : 'Sin socios todavía'}
            </p>
            <p className="ek-body-faint" style={{ margin: '4px 0 0' }}>
              {q.trim() ? 'Probá con otro nombre o teléfono.' : 'Los socios aparecen acá al darlos de alta.'}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {socios.map((s) => (
              <SocioRow key={s.id} socio={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SocioRow({ socio }: { socio: SocioListItem }) {
  return (
    <Link
      to={`/recepcion/socios/${socio.id}`}
      className="ek-card ek-card-interactive"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        padding: '12px 14px',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      {socio.avatar_url ? (
        <img
          src={socio.avatar_url}
          alt=""
          loading="lazy"
          style={{ width: '44px', height: '44px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
        />
      ) : (
        <div
          aria-hidden="true"
          style={{
            width: '44px',
            height: '44px',
            borderRadius: '50%',
            background: 'var(--sala-primary-light)',
            color: 'var(--sala-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--ek-font-display)',
            fontWeight: 700,
            fontSize: '15px',
            flexShrink: 0,
          }}
        >
          {iniciales(socio.nombre)}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontWeight: 600, fontSize: '15px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {socio.nombre ?? socio.email}
        </p>
        <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--sala-text-tertiary)' }}>
          {socio.telefono ?? socio.email}
        </p>
      </div>
      <ChevronRight size={18} style={{ color: 'var(--sala-text-tertiary)', flexShrink: 0 }} />
    </Link>
  );
}
