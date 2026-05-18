import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';

const SIDEBAR_COLLAPSED_KEY = 'ekko-admin-sidebar-collapsed';
const VER_COMO_LABEL = 'VER COMO…';

function readCollapsed(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(s: Set<string>) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(Array.from(s)));
  } catch {
    // ignore quota / private mode errors
  }
}

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  badge?: string;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    label: 'OPERACIÓN',
    items: [
      {
        to: '/admin',
        label: 'Dashboard',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
        )
      },
      {
        to: '/admin/miembros',
        label: 'Miembros',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        )
      },
      {
        to: '/admin/calendario',
        label: 'Reservas',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        )
      }
    ]
  },
  {
    label: 'CATÁLOGO',
    items: [
      {
        to: '/admin/recursos',
        label: 'Estudios',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" />
          </svg>
        )
      },
      {
        to: '/admin/tiers',
        label: 'Planes',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
            <line x1="7" y1="7" x2="7.01" y2="7" />
          </svg>
        )
      }
    ]
  },
  {
    label: 'EQUIPO',
    items: [
      {
        to: '/admin/equipo',
        label: 'Personas',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        )
      }
    ]
  },
  {
    label: 'AJUSTES',
    items: [
      {
        to: '/admin/landing',
        label: 'Landing',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        )
      },
      {
        to: '/admin/contacto',
        label: 'Contacto',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
          </svg>
        )
      },
      {
        to: '/admin/reglas',
        label: 'Reglas',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <polyline points="12 7 12 12 15 14" />
          </svg>
        )
      },
      {
        to: '/admin/marca',
        label: 'Marca',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="4" />
          </svg>
        )
      }
    ]
  }
];

interface VerComoLink {
  label: string;
  icon: string;
  href: string;
}

const VER_COMO_LINKS: VerComoLink[] = [
  // Signup excluido a propósito (Sprint D-Polish): admin ya lo ve en el
  // flow normal cuando un visitante hace click en una membresía desde Landing.
  { label: 'Landing', icon: '🏠', href: '/?demo=admin-preview' },
  { label: 'Miembro', icon: '👤', href: '/app?demo=admin-preview' },
  { label: 'Recepción', icon: '📋', href: '/recepcion?demo=admin-preview' }
];

interface Props {
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: Props = {}) {
  const { usuario, signOut } = useAuth();
  const tenant = useTenant();
  const navigate = useNavigate();
  const location = useLocation();

  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed());

  const toggleSection = (label: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      writeCollapsed(next);
      return next;
    });
  };

  // Auto-expandir la sección que contiene la ruta activa SOLO cuando cambia
  // la URL (no cada vez que `collapsed` cambia). Si el admin colapsa una
  // sección estando dentro de ella, se queda colapsada — su elección manda.
  // Usamos un ref de `collapsed` para no re-disparar el effect al colapsar.
  const collapsedRef = useRef(collapsed);
  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  useEffect(() => {
    const activeSection = SECTIONS.find((s) =>
      s.items.some(
        (item) =>
          item.to === '/admin'
            ? location.pathname === '/admin'
            : location.pathname.startsWith(item.to)
      )
    );
    if (activeSection && collapsedRef.current.has(activeSection.label)) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(activeSection.label);
        writeCollapsed(next);
        return next;
      });
    }
  }, [location.pathname]);

  const branding = (tenant.branding ?? {}) as Record<string, unknown>;
  const logoUrl =
    typeof branding.logo_url_dark === 'string'
      ? branding.logo_url_dark
      : typeof branding.logo_url === 'string'
        ? (branding.logo_url as string)
        : null;
  const brandShort = (tenant.nombre || 'EKKO').split(/\s+/)[0];

  const nombreFormat =
    usuario?.nombre
      ?.toLowerCase()
      .split(' ')
      .filter(Boolean)
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') ?? '';

  return (
    <aside className="adm-sidebar">
      <div className="adm-sidebar-brand">
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={tenant.nombre}
            style={{ maxHeight: '40px', maxWidth: '160px', objectFit: 'contain', display: 'block' }}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span
              style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '20px',
                fontWeight: 700,
                letterSpacing: '-0.04em',
                color: 'var(--ek-mustard)'
              }}
            >
              {brandShort}
            </span>
            <span className="ek-eyebrow" style={{ fontSize: '10px' }}>STUDIO</span>
          </div>
        )}
        <span
          className="ek-badge"
          style={{
            marginTop: '8px',
            backgroundColor: 'var(--ek-mustard)',
            color: 'var(--ek-bg)',
            fontSize: '9px',
            fontWeight: 700,
            letterSpacing: '0.12em',
            padding: '4px 10px',
            alignSelf: 'flex-start',
            width: 'fit-content'
          }}
        >
          ADMIN
        </span>
      </div>

      <nav className="adm-sidebar-nav">
        {SECTIONS.map((section) => {
          const isCollapsed = collapsed.has(section.label);
          return (
            <div key={section.label} className="adm-sidebar-section">
              <SectionToggle
                label={section.label}
                collapsed={isCollapsed}
                onToggle={() => toggleSection(section.label)}
              />
              {!isCollapsed &&
                section.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/admin'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      `adm-sidebar-item ${isActive ? 'adm-sidebar-item--active' : ''}`
                    }
                  >
                    <span className="adm-sidebar-item-icon">{item.icon}</span>
                    <span style={{ flex: 1 }}>{item.label}</span>
                    {item.badge && (
                      <span
                        style={{
                          fontSize: '8px',
                          letterSpacing: '0.1em',
                          color: 'var(--ek-ink-faint)',
                          fontWeight: 700,
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {item.badge}
                      </span>
                    )}
                  </NavLink>
                ))}
            </div>
          );
        })}

        <div className="adm-sidebar-section">
          <SectionToggle
            label={VER_COMO_LABEL}
            collapsed={collapsed.has(VER_COMO_LABEL)}
            onToggle={() => toggleSection(VER_COMO_LABEL)}
          />
          {!collapsed.has(VER_COMO_LABEL) &&
            VER_COMO_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                title="Abre en nueva pestaña"
                className="adm-sidebar-item"
                style={{
                  border: '0.5px solid var(--ek-line)',
                  marginTop: '4px'
                }}
              >
                <span className="adm-sidebar-item-icon" aria-hidden="true">
                  {link.icon}
                </span>
                <span style={{ flex: 1 }}>{link.label}</span>
                <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>↗</span>
              </a>
            ))}
        </div>
      </nav>

      <div className="adm-sidebar-footer">
        <div style={{ marginBottom: '12px' }}>
          <p className="ek-eyebrow" style={{ fontSize: '9px', marginBottom: '4px' }}>
            CONECTADO
          </p>
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '14px',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              margin: 0,
              color: 'var(--ek-ink)'
            }}
          >
            {nombreFormat || usuario?.email}
          </p>
        </div>
        <button
          onClick={() => {
            signOut();
            navigate('/login');
          }}
          className="ek-icon-btn"
          style={{
            width: '100%',
            padding: '10px',
            fontSize: '13px',
            textAlign: 'center'
          }}
        >
          Cerrar sesión →
        </button>
      </div>
    </aside>
  );
}

function SectionToggle({
  label,
  collapsed,
  onToggle
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="ek-eyebrow adm-sidebar-section-label"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        width: '100%',
        padding: '8px 8px 6px',
        background: 'transparent',
        border: 'none',
        color: 'var(--ek-ink-faint)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'left'
      }}
    >
      <span>{label}</span>
      <span
        aria-hidden="true"
        style={{
          fontSize: '10px',
          transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          transition: 'transform 0.18s ease',
          color: 'var(--ek-ink-faint)'
        }}
      >
        ▾
      </span>
    </button>
  );
}
