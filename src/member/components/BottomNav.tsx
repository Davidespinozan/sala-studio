import { NavLink } from 'react-router-dom';
import { Home, Calendar, LayoutGrid, User } from 'lucide-react';

export function BottomNav() {
  return (
    <nav className="ek-bottom-nav">
      <div className="ek-bottom-nav-inner">
        <NavItem to="/app" end icon={<Home size={22} className="ek-bottom-nav-icon" />} label="Inicio" />
        <NavItem to="/app/estudios" icon={<LayoutGrid size={22} className="ek-bottom-nav-icon" />} label="Estudios" />
        <NavItem to="/app/reservar" icon={<Calendar size={22} className="ek-bottom-nav-icon" />} label="Reservar" />
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
