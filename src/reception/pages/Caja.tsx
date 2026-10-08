import { CajaView } from '@admin/pages/Caja';
import { useReceptionSucursal } from '../providers/ReceptionSucursalProvider';

/**
 * Caja del MOSTRADOR: la misma pantalla que el admin, fija a la sede de la
 * recepción (cobros del día, por cobrar, corregir método, corte de turno).
 * Devolver dinero y los ajustes del ticket quedan en el admin.
 */
export default function CajaRecepcion() {
  const { sucursalId, sucursalNombre } = useReceptionSucursal();
  return <CajaView modo="recepcion" sucursalFiltro={sucursalId} sucursalNombre={sucursalNombre} />;
}
