import { useState } from 'react';
import PosVenta from './PosVenta';
import VentasTienda from '@shared/tienda/VentasTienda';
import Entregas from './Entregas';
import { useReceptionSucursal } from '../providers/ReceptionSucursalProvider';

/* La Tienda en recepción: VENDER (el POS) y VENTAS (el historial rastreable).
   Mismo historial que ve el admin — recepción también necesita saber qué se
   vendió, cuándo y a quién, buscable por fecha. */
export default function TiendaRecepcion() {
  const [vista, setVista] = useState<'vender' | 'ventas' | 'entregas'>('vender');
  const { sucursalId } = useReceptionSucursal();

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {(['vender', 'ventas', 'entregas'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setVista(v)}
            className={vista === v ? 'ek-cta' : 'ek-cta ek-cta--secondary'}
          >
            {v === 'vender' ? 'Vender' : v === 'ventas' ? 'Ventas' : 'Entregas'}
          </button>
        ))}
      </div>
      {vista === 'vender' ? <PosVenta /> : vista === 'ventas' ? <VentasTienda sucursalId={sucursalId} /> : <Entregas />}
    </div>
  );
}
