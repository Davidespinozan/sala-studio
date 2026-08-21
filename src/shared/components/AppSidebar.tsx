import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { TenantLogo } from '@shared/components/TenantLogo';
import { PoweredBySala } from '@shared/components/PoweredBySala';

/**
 * Sidebar oscuro teñido reutilizable (admin + recepción). Mismo sistema visual
 * (.adm-sidebar*), parametrizado por las secciones de nav, el rol y opciones.
 * El comportamiento de admin (secciones colapsables con localStorage, VER COMO)
 * queda intacto vía props; recepción lo usa plano (collapsible=false).
 */

export interface AppNavItem {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: string;
}
export interface AppNavSection {
  /** Encabezado de sección. Sin label → no se renderiza header (nav plano). */
  label?: string;
  items: AppNavItem[];
}
export interface VerComoLink {
  label: string;
  icon: ReactNode;
  href: string;
}

const VER_COMO_LABEL = 'VER COMO…';

function readCollapsed(key: string): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function writeCollapsed(key: string, s: Set<string>) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(s)));
  } catch {
    // ignore quota / private mode errors
  }
}

interface Props {
  sections: AppNavSection[];
  /** Texto del badge bajo el logo ("ADMIN" / "RECEPCIÓN"). */
  roleLabel: string;
  /** Ruta "home" del rol — el item con to===homePath usa `end` para el active. */
  homePath: string;
  /** Links externos "VER COMO…" (admin). Omitir → no se muestra la sección. */
  verComoLinks?: VerComoLink[];
  /** Secciones colapsables con persistencia (admin). Default false (plano). */
  collapsible?: boolean;
  /** Key de localStorage cuando collapsible. */
  collapseKey?: string;
  /** Bloque discreto sobre el footer (recepción: estado del sistema + actividad). */
  statusSlot?: ReactNode;
  onNavigate?: () => void;
}

export function AppSidebar({
  sections,
  roleLabel,
  homePath,
  verComoLinks,
  collapsible = false,
  collapseKey = 'sala-sidebar-collapsed',
  statusSlot,
  onNavigate
}: Props) {
  const { usuario, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    collapsible ? readCollapsed(collapseKey) : new Set()
  );

  const toggleSection = (label: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      writeCollapsed(collapseKey, next);
      return next;
    });
  };

  // Auto-expandir la sección que contiene la ruta activa al cambiar la URL
  // (solo en modo colapsable). Si el usuario colapsó estando dentro, se respeta.
  const collapsedRef = useRef(collapsed);
  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  useEffect(() => {
    if (!collapsible) return;
    const activeSection = sections.find((s) =>
      s.label
        ? s.items.some((item) =>
            item.to === homePath
              ? location.pathname === homePath
              : location.pathname.startsWith(item.to)
          )
        : false
    );
    if (activeSection?.label && collapsedRef.current.has(activeSection.label)) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(activeSection.label!);
        writeCollapsed(collapseKey, next);
        return next;
      });
    }
  }, [location.pathname, collapsible, sections, homePath, collapseKey]);

  // Flechas de scroll CLICABLES para la nav. La compu vieja de numa no hace scroll
  // con el mouse, así que en pantallas donde el menú no cabe no llegaban a los ítems
  // de abajo. Las flechas aparecen SOLO cuando hay contenido oculto en esa dirección
  // y desplazan la barra ~una página por clic. En pantallas donde todo cabe, no salen.
  const navRef = useRef<HTMLElement>(null);
  const [flechas, setFlechas] = useState({ arriba: false, abajo: false });

  const actualizarFlechas = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    const arriba = el.scrollTop > 4;
    const abajo = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
    setFlechas((prev) => (prev.arriba === arriba && prev.abajo === abajo ? prev : { arriba, abajo }));
  }, []);

  useEffect(() => {
    actualizarFlechas();
    window.addEventListener('resize', actualizarFlechas);
    return () => window.removeEventListener('resize', actualizarFlechas);
  }, [sections, collapsed, actualizarFlechas]);

  const desplazar = (dir: 1 | -1) => {
    const el = navRef.current;
    if (el) el.scrollBy({ top: dir * Math.max(120, el.clientHeight * 0.7), behavior: 'smooth' });
  };

  const nombreFormat =
    usuario?.nombre
      ?.toLowerCase()
      .split(' ')
      .filter(Boolean)
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') ?? '';

  const renderItem = (item: AppNavItem) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.to === homePath}
      onClick={onNavigate}
      className={({ isActive }) => `adm-sidebar-item ${isActive ? 'adm-sidebar-item--active' : ''}`}
    >
      <span className="adm-sidebar-item-icon">{item.icon}</span>
      <span style={{ flex: 1 }}>{item.label}</span>
      {item.badge && (
        <span
          style={{
            fontSize: '8px',
            letterSpacing: '0.1em',
            color: 'rgba(255, 255, 255, 0.55)',
            fontWeight: 700,
            whiteSpace: 'nowrap'
          }}
        >
          {item.badge}
        </span>
      )}
    </NavLink>
  );

  return (
    <aside className="adm-sidebar">
      <div className="adm-sidebar-brand">
        <TenantLogo variant="completo" height={60} fallbackFontSize={32} showSuffix={true} />
        <span
          className="ek-badge"
          style={{
            marginTop: '8px',
            backgroundColor: 'transparent',
            color: 'rgba(255, 255, 255, 0.85)',
            border: '0.5px solid rgba(255, 255, 255, 0.22)',
            fontSize: '9px',
            fontWeight: 700,
            letterSpacing: '0.12em',
            padding: '4px 10px',
            alignSelf: 'flex-start',
            width: 'fit-content'
          }}
        >
          {roleLabel}
        </span>
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <FlechaScroll dir="arriba" visible={flechas.arriba} onClick={() => desplazar(-1)} />
        <nav className="adm-sidebar-nav" ref={navRef} onScroll={actualizarFlechas} style={{ flex: 1, minHeight: 0 }}>
        {sections.map((section, i) => {
          const key = section.label ?? `__sec${i}`;
          const isCollapsed = collapsible && !!section.label && collapsed.has(section.label);
          return (
            <div key={key} className="adm-sidebar-section">
              {section.label &&
                (collapsible ? (
                  <SectionToggle
                    label={section.label}
                    collapsed={isCollapsed}
                    onToggle={() => toggleSection(section.label!)}
                  />
                ) : (
                  <p className="ek-eyebrow adm-sidebar-section-label" style={{ padding: '8px 8px 6px', margin: 0, color: 'rgba(255, 255, 255, 0.60)' }}>
                    {section.label}
                  </p>
                ))}
              {!isCollapsed && section.items.map(renderItem)}
            </div>
          );
        })}

        {verComoLinks && verComoLinks.length > 0 && (
          <div className="adm-sidebar-section">
            {collapsible ? (
              <SectionToggle
                label={VER_COMO_LABEL}
                collapsed={collapsed.has(VER_COMO_LABEL)}
                onToggle={() => toggleSection(VER_COMO_LABEL)}
              />
            ) : (
              <p className="ek-eyebrow adm-sidebar-section-label" style={{ padding: '8px 8px 6px', margin: 0, color: 'rgba(255, 255, 255, 0.60)' }}>
                {VER_COMO_LABEL}
              </p>
            )}
            {(!collapsible || !collapsed.has(VER_COMO_LABEL)) &&
              verComoLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Abre en nueva pestaña"
                  className="adm-sidebar-item"
                  style={{ border: '0.5px solid rgba(255, 255, 255, 0.15)', marginTop: '4px' }}
                >
                  <span className="adm-sidebar-item-icon" aria-hidden="true">
                    {link.icon}
                  </span>
                  <span style={{ flex: 1 }}>{link.label}</span>
                  <span style={{ fontSize: '11px', color: 'rgba(255, 255, 255, 0.55)' }}>↗</span>
                </a>
              ))}
          </div>
        )}
        </nav>
        <FlechaScroll dir="abajo" visible={flechas.abajo} onClick={() => desplazar(1)} />
      </div>

      <div className="adm-sidebar-footer">
        {statusSlot}
        <div style={{ marginBottom: '12px' }}>
          <p className="ek-eyebrow" style={{ fontSize: '9px', marginBottom: '4px', color: 'rgba(255, 255, 255, 0.55)' }}>
            CONECTADO
          </p>
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '14px',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              margin: 0,
              color: 'rgba(255, 255, 255, 0.92)'
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
          className="ek-icon-btn adm-sidebar-signout"
          style={{
            width: '100%',
            padding: '10px',
            fontSize: '13px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px'
          }}
        >
          <LogOut size={15} strokeWidth={2.25} />
          Cerrar sesión
        </button>
        <PoweredBySala align="center" tone="dark" />
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
        color: 'rgba(255, 255, 255, 0.60)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'left'
      }}
    >
      <span>{label}</span>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          transition: 'transform 0.18s ease',
          color: 'rgba(255, 255, 255, 0.50)'
        }}
      >
        <ChevronDown size={14} strokeWidth={2.25} />
      </span>
    </button>
  );
}

/** Flecha clicable para desplazar la nav sin scroll de mouse (compu vieja de numa).
 *  Se muestra solo cuando hay contenido oculto en esa dirección. */
function FlechaScroll({
  dir,
  visible,
  onClick
}: {
  dir: 'arriba' | 'abajo';
  visible: boolean;
  onClick: () => void;
}) {
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir === 'arriba' ? 'Desplazar menú hacia arriba' : 'Desplazar menú hacia abajo'}
      title={dir === 'arriba' ? 'Ver opciones de arriba' : 'Ver más opciones'}
      style={{
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        ...(dir === 'arriba' ? { top: '2px' } : { bottom: '2px' }),
        zIndex: 5,
        width: '44px',
        height: '22px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '999px',
        border: '0.5px solid rgba(255, 255, 255, 0.28)',
        background: 'rgba(20, 20, 20, 0.88)',
        color: 'rgba(255, 255, 255, 0.92)',
        cursor: 'pointer',
        boxShadow: '0 2px 10px rgba(0, 0, 0, 0.4)'
      }}
    >
      {dir === 'arriba'
        ? <ChevronUp size={16} strokeWidth={2.5} />
        : <ChevronDown size={16} strokeWidth={2.5} />}
    </button>
  );
}
