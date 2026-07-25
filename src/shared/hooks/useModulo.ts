import { useTenant } from '@shared/hooks/useTenant';
import { moduloActivo, type Modulo } from '@shared/lib/modulos';

/**
 * ¿El gym actual tiene este complemento activo?
 *
 * Es la puerta que usan el menú y las vistas para decidir "¿muestro el módulo,
 * o la página que invita a activarlo?". Lee de `tenants.config.modulos`, que es
 * lo que el webhook prende cuando el gym paga el renglón del complemento.
 *
 * Ejemplo:
 *   const tieneTienda = useModulo('tienda');
 *   return tieneTienda ? <Tienda /> : <ActivarTienda />;
 */
export function useModulo(id: Modulo): boolean {
  const tenant = useTenant();
  return moduloActivo(tenant.config as Record<string, unknown> | null, id);
}