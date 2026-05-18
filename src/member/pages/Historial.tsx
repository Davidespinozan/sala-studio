import { Navigate } from 'react-router-dom';

// Tab "Historial" removida del bottom nav. Las reservas pasadas viven
// dentro de /app/perfil. Mantenemos este componente como redirect
// compat para no romper links viejos.
export default function Historial() {
  return <Navigate to="/app/perfil" replace />;
}
