import { NavLink } from 'react-router-dom';
import { Home, Calendar, LayoutGrid, ShoppingBag, User } from 'lucide-react';
import { useTenant } from '@shared/hooks/useTenant';
import { useModulo } from '@shared/hooks/useModulo';
import { ventaSocioActiva } from '@shared/lib/tiendaConfig';

export function BottomNav() {
  const tenant = useTenant();
  // "Tienda" solo si el gym tiene el complemento Y prendió la venta desde la app.
  const mostrarTienda =
    useModulo('tienda') && ventaSocioActiva(tenant.config as Record<string, unknown> | null);

  return (
    <nav className="ek-bottom-nav">
      <div className="ek-bottom-nav-inner">
        <NavItem to="/app" end icon={<Home size={22} className="ek-bottom-nav-icon" />} label="Inicio" />
        <NavItem to="/app/estudios" icon={<LayoutGrid size={22} className="ek-bottom-nav-icon" />} label="Salas" />
        <NavItem to="/app/reservar" icon={<Calendar size={22} className="ek-bottom-nav-icon" />} label="Reservar" />
        {mostrarTienda && (
          <NavItem to="/app/tienda" icon={<ShoppingBag size={22} className="ek-bottom-nav-icon" />} label="Tienda" />
        )}
        <NavItem to="/app/perfil" icon={<User size={22} className="ek-bottom-nav-icon" />} label="Perfil" />
      </div>
    </nav>
  );
}

function NavItem({ to, icon, label, end }: { to: string; icon: React.ReactNode; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `ek-bottom-nav-item ${isActive ? 'ek-bottom-nav-item--active' : ''}`
      }
    >
      {icon}
      <span className="ek-bottom-nav-item-label">{label}</span>
    </NavLink>
  );
}
