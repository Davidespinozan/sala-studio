import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Search, ChevronRight } from 'lucide-react';
import { PageHeader } from '@shared/components/PageHeader';
import { EmptyState } from '@shared/components/EmptyState';
import { useSocios, type SocioListItem } from '../hooks/useSocios';

function iniciales(nombre: string | null): string {
  const t = (nombre ?? '').trim().split(/\s+/).filter(Boolean);
  if (!t.length) return '?';
  return (t[0][0] + (t[1]?.[0] ?? '')).toUpperCase();
}

// Persistencia de la última búsqueda: F5 reabre el buscador donde estaba.
// Se ignora si lo guardado tiene > 1h (una búsqueda vieja no es relevante).
const QUERY_KEY = 'sala-recepcion-socios-query';
const QUERY_TTL_MS = 3600000;

function leerQueryGuardada(): string {
  try {
    const raw = localStorage.getItem(QUERY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { value?: string; savedAt?: number };
      if (
        typeof parsed.value === 'string' &&
        typeof parsed.savedAt === 'number' &&
        Date.now() - parsed.savedAt <= QUERY_TTL_MS
      ) {
        return parsed.value;
      }
    }
  } catch {
    // localStorage no disponible / JSON inválido → default ''
  }
  return '';
}

function guardarQuery(value: string): void {
  try {
    localStorage.setItem(QUERY_KEY, JSON.stringify({ value, savedAt: Date.now() }));
  } catch {
    // private mode / quota → no-op
  }
}

export default function Socios() {
  const [q, setQ] = useState<string>(() => leerQueryGuardada());
  const { socios, isLoading, error } = useSocios(q);

  // Persistir la búsqueda cada vez que cambia.
  useEffect(() => {
    guardarQuery(q);
  }, [q]);

  return (
    <div className="ek-page">
      <div style={{ maxWidth: '640px', margin: '0 auto', padding: '20px' }}>
        <PageHeader eyebrow="RECEPCIÓN" title="Socios" subtitle="Busca por nombre o teléfono" />

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

        {error && (
          <div
            style={{
              background: 'var(--ek-danger-soft)',
              border: '1px solid var(--sala-error-glow)',
              color: 'var(--ek-danger)',
              borderRadius: 'var(--ek-r-md)',
              padding: '10px 12px',
              marginBottom: '14px',
              fontSize: '0.875rem',
            }}
          >
            {error}
          </div>
        )}

        {isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="ek-skeleton" style={{ height: '64px', borderRadius: 'var(--ek-r-md)' }} />
            ))}
          </div>
        ) : socios.length === 0 ? (
          <EmptyState
            icon={Search}
            title={q.trim() ? 'Sin resultados' : 'Sin socios todavía'}
            subtitle={q.trim() ? 'Prueba con otro nombre o teléfono.' : 'Los socios aparecen acá al darlos de alta.'}
          />
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
