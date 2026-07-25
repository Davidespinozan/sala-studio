import { useState } from 'react';
import PosVenta from './PosVenta';
import VentasTienda from '@shared/tienda/VentasTienda';
import { useReceptionSucursal } from '../providers/ReceptionSucursalProvider';

/* La Tienda en recepción: VENDER (el POS) y VENTAS (el historial rastreable).
   Mismo historial que ve el admin — recepción también necesita saber qué se
   vendió, cuándo y a quién, buscable por fecha. */
export default function TiendaRecepcion() {
  const [vista, setVista] = useState<'vender' | 'ventas'>('vender');
  const { sucursalId } = useReceptionSucursal();

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {(['vender', 'ventas'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setVista(v)}
            className="ek-btn-secondary"
            style={vista === v ? { background: 'var(--sala-primary)', color: '#fff' } : {}}
          >
            {v === 'vender' ? 'Vender' : 'Ventas'}
          </button>
        ))}
      </div>
      {vista === 'vender' ? <PosVenta /> : <VentasTienda sucursalId={sucursalId} />}
    </div>
  );
}
