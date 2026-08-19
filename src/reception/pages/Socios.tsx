import { useState, useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Search, ChevronRight } from 'lucide-react';
import { EmptyState } from '@shared/components/EmptyState';
import { useSocios, type SocioListItem } from '../hooks/useSocios';
import { useReceptionSucursal } from '../providers/ReceptionSucursalProvider';
import { RegistrarSocioModal } from '../components/RegistrarSocioModal';
import { Avatar } from '@shared/components/Avatar';

function capitalizar(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Badge de estado del socio (triage de un vistazo). */
function estadoBadge(status: string): { label: string; bg: string; color: string } {
  switch (status) {
    case 'activo':
      return { label: 'Activo', bg: 'var(--ek-success-soft)', color: 'var(--ek-success)' };
    case 'pendiente_pago':
      return { label: 'Pendiente', bg: 'color-mix(in srgb, var(--ek-mustard) 16%, transparent)', color: 'color-mix(in srgb, var(--ek-mustard), black 18%)' };
    case 'pendiente_onboarding':
      return { label: 'Sin onboarding', bg: 'color-mix(in srgb, var(--ek-mustard) 16%, transparent)', color: 'color-mix(in srgb, var(--ek-mustard), black 18%)' };
    case 'congelado':
      return { label: 'Pausado', bg: 'var(--sala-primary-light)', color: 'var(--sala-primary)' };
    case 'suspendido':
    case 'revocado':
    case 'cancelado':
      return { label: capitalizar(status), bg: 'var(--ek-danger-soft)', color: 'var(--ek-danger)' };
    default:
      return { label: capitalizar(status), bg: 'var(--sala-bg)', color: 'var(--sala-text-tertiary)' };
  }
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
  const [showNuevo, setShowNuevo] = useState(false);
  const { socios, isLoading, error, refetch } = useSocios(q);
  const { sucursalId, sucursales, multisede } = useReceptionSucursal();
  // Etiqueta de sede para socios que NO son de este mostrador (solo multisede).
  const sedeDe = (id: string | null): string | null =>
    multisede && id && id !== sucursalId
      ? sucursales.find((s) => s.id === id)?.nombre ?? null
      : null;

  // Persistir la búsqueda cada vez que cambia.
  useEffect(() => {
    guardarQuery(q);
  }, [q]);

  // Paginación: recepción recorre TODOS los socios por páginas (no solo A–C).
  const POR_PAGINA = 30;
  const [pagina, setPagina] = useState(1);
  useEffect(() => { setPagina(1); }, [q]); // nueva búsqueda → volver a la página 1
  const totalPaginas = Math.max(1, Math.ceil(socios.length / POR_PAGINA));
  const paginaSegura = Math.min(pagina, totalPaginas);
  const visibles = socios.slice((paginaSegura - 1) * POR_PAGINA, paginaSegura * POR_PAGINA);

  return (
    <div className="ek-page">
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '16px 20px' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '6px' }}>RECEPCIÓN</p>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', margin: '0 0 14px' }}>
          <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '28px', fontWeight: 700, letterSpacing: '-0.03em', margin: 0, color: 'var(--sala-text-primary)' }}>
            Socios
          </h1>
          <button className="ek-cta" style={{ flex: '0 0 auto' }} onClick={() => setShowNuevo(true)}>
            + Nuevo socio
          </button>
        </div>

        {/* Buscador protagonista (estilo Spotlight) */}
        <div style={{ position: 'relative', marginBottom: '18px' }}>
          <Search size={20} style={{ position: 'absolute', left: '18px', top: '50%', transform: 'translateY(-50%)', color: 'var(--sala-text-tertiary)', pointerEvents: 'none' }} />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar socio por nombre o teléfono…"
            autoFocus
            style={{
              width: '100%', boxSizing: 'border-box',
              paddingLeft: '52px', paddingRight: '16px',
              minHeight: '60px', fontSize: '18px', fontWeight: 500,
              borderRadius: '16px', border: '1px solid var(--sala-border)',
              background: 'var(--sala-surface)', color: 'var(--sala-text-primary)',
              fontFamily: 'inherit', outline: 'none',
              boxShadow: '0 1px 2px rgba(10,15,12,0.04), 0 10px 30px rgba(10,15,12,0.06)',
              transition: 'border-color .15s ease, box-shadow .15s ease'
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--sala-primary)'; e.currentTarget.style.boxShadow = '0 0 0 4px color-mix(in srgb, var(--sala-primary) 12%, transparent), 0 10px 30px rgba(10,15,12,0.08)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--sala-border)'; e.currentTarget.style.boxShadow = '0 1px 2px rgba(10,15,12,0.04), 0 10px 30px rgba(10,15,12,0.06)'; }}
          />
        </div>

        {!isLoading && !error && socios.length > 0 && (
          <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--sala-text-tertiary)', margin: '0 0 12px 2px' }}>
            {q.trim()
              ? `${socios.length} resultado${socios.length === 1 ? '' : 's'}`
              : `Socios de esta sede (${socios.length})${totalPaginas > 1 ? ` · pág. ${paginaSegura} de ${totalPaginas}` : ''}`}
          </p>
        )}

        {error && (
          <div style={{ background: 'var(--ek-danger-soft)', border: '1px solid var(--sala-error-glow)', color: 'var(--ek-danger)', borderRadius: 'var(--ek-r-md)', padding: '10px 12px', marginBottom: '14px', fontSize: '0.875rem' }}>
            {error}
          </div>
        )}

        {isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="ek-skeleton" style={{ height: '68px', borderRadius: '14px' }} />
            ))}
          </div>
        ) : socios.length === 0 ? (
          <EmptyState
            icon={Search}
            title={q.trim() ? 'Sin resultados' : 'Sin socios todavía'}
            subtitle={q.trim() ? 'Prueba con otro nombre o teléfono.' : 'Los socios aparecen acá al darlos de alta.'}
          />
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {visibles.map((s) => (
                <SocioRow key={s.id} socio={s} sedeBadge={sedeDe(s.sucursal_id)} />
              ))}
            </div>
            <Paginador pagina={paginaSegura} total={totalPaginas} onCambio={setPagina} />
          </>
        )}
      </div>

      <RegistrarSocioModal
        isOpen={showNuevo}
        onClose={() => setShowNuevo(false)}
        onDone={refetch}
      />
    </div>
  );
}

/** Números de página abajo de la lista (con ventana + elipsis si son muchas). */
function Paginador({ pagina, total, onCambio }: { pagina: number; total: number; onCambio: (p: number) => void }) {
  if (total <= 1) return null;
  const nums: (number | 'gap')[] = [];
  const from = Math.max(2, pagina - 1);
  const to = Math.min(total - 1, pagina + 1);
  nums.push(1);
  if (from > 2) nums.push('gap');
  for (let i = from; i <= to; i++) nums.push(i);
  if (to < total - 1) nums.push('gap');
  if (total > 1) nums.push(total);
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '18px' }}>
      <PagBtn disabled={pagina <= 1} onClick={() => onCambio(pagina - 1)}>‹</PagBtn>
      {nums.map((n, i) =>
        n === 'gap' ? (
          <span key={`gap-${i}`} style={{ color: 'var(--sala-text-tertiary)', padding: '0 2px' }}>…</span>
        ) : (
          <PagBtn key={n} activo={n === pagina} onClick={() => onCambio(n)}>{n}</PagBtn>
        )
      )}
      <PagBtn disabled={pagina >= total} onClick={() => onCambio(pagina + 1)}>›</PagBtn>
    </div>
  );
}

function PagBtn({ children, onClick, activo, disabled }: { children: ReactNode; onClick: () => void; activo?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        minWidth: '34px', height: '34px', padding: '0 8px', borderRadius: '8px',
        fontSize: '13px', fontWeight: 700, fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
        border: `1px solid ${activo ? 'var(--sala-primary)' : 'var(--sala-border)'}`,
        background: activo ? 'var(--grad-primary)' : 'var(--sala-surface)',
        color: activo ? 'var(--sala-text-on-primary)' : 'var(--sala-text-secondary)'
      }}
    >
      {children}
    </button>
  );
}

function SocioRow({ socio, sedeBadge }: { socio: SocioListItem; sedeBadge: string | null }) {
  const estado = estadoBadge(socio.status);
  return (
    <Link
      to={`/recepcion/socios/${socio.id}`}
      style={{
        display: 'flex', alignItems: 'center', gap: '14px',
        padding: '12px 16px', borderRadius: '14px',
        background: 'var(--sala-surface)', border: '1px solid var(--sala-border)',
        textDecoration: 'none', color: 'inherit',
        transition: 'border-color .14s ease'
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--sala-primary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--sala-border)'; }}
    >
      <Avatar src={socio.avatar_url} nombre={socio.nombre} size={44} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontWeight: 600, fontSize: '15px', color: 'var(--sala-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {socio.nombre ?? socio.email}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginTop: '4px', minWidth: 0 }}>
          {socio.es_invitado && !socio.membresia_tier && (
            <span style={{ flexShrink: 0, fontSize: '10px', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--sala-accent)', background: 'var(--sala-accent-light)', borderRadius: '999px', padding: '2px 8px', lineHeight: 1.5 }}>
              Invitado
            </span>
          )}
          {socio.membresia_tier && (
            <span style={{ flexShrink: 0, fontSize: '10px', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--sala-primary)', background: 'var(--sala-primary-light)', borderRadius: '999px', padding: '2px 8px', lineHeight: 1.5 }}>
              {socio.membresia_tier}
            </span>
          )}
          <span style={{ flexShrink: 0, fontSize: '10px', fontWeight: 800, letterSpacing: '0.05em', borderRadius: '999px', padding: '2px 9px', background: estado.bg, color: estado.color, whiteSpace: 'nowrap' }}>
            {estado.label}
          </span>
          <span style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            · {socio.telefono ?? socio.email}
          </span>
        </div>
      </div>
      {sedeBadge && (
        <span style={{ flexShrink: 0, padding: '3px 9px', borderRadius: '999px', background: 'var(--sala-bg)', color: 'var(--sala-text-tertiary)', fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap' }}>
          {sedeBadge}
        </span>
      )}
      <ChevronRight size={18} style={{ color: 'var(--sala-text-tertiary)', flexShrink: 0 }} />
    </Link>
  );
}
