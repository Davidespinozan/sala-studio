import { useState } from 'react';
import { backendPost } from '@shared/lib/backend';
import { useToast } from '@shared/hooks/useToast';
import { useModulo } from '@shared/hooks/useModulo';
import { useTenantRefetch } from '@shared/hooks/useTenant';
import GestionTienda from './GestionTienda';

/* ══════════════════════════════════════════════════════════════════════════
   TIENDA — la puerta del complemento.
   ──────────────────────────────────────────────────────────────────────────
   Si el gym lo contrató → la tienda (el POS llega en la próxima entrega).
   Si no → la página que lo ofrece y lo activa de un toque.

   El estado sale de `useModulo('tienda')`, que lee `config.modulos.tienda` —
   lo que el webhook prende cuando el cobro entra. Una sola fuente de verdad.
   ══════════════════════════════════════════════════════════════════════════ */
export default function Tienda() {
  const activa = useModulo('tienda');
  // Contratada → la gestión (cargar productos, stock, reportes).
  // Sin contratar → la página que la ofrece y la activa.
  return activa ? <GestionTienda /> : <ActivarTienda />;
}

// ── El gym todavía no la tiene: la página de venta ──────────────────────────
function ActivarTienda() {
  const toast = useToast();
  const refetch = useTenantRefetch();
  const [estado, setEstado] = useState<'idle' | 'activando' | 'esperando'>('idle');

  async function activar() {
    setEstado('activando');
    try {
      await backendPost('complemento-saas', { modulo: 'tienda', accion: 'activar' });
      // El cobro entró; el módulo lo prende el WEBHOOK, unos segundos después.
      // Se refresca el tenant un par de veces hasta que aparezca.
      setEstado('esperando');
      toast.success('¡Listo! Activando tu tienda…');
      for (const espera of [2000, 3000, 4000]) {
        await new Promise((r) => setTimeout(r, espera));
        await refetch();
      }
    } catch (e) {
      setEstado('idle');
      toast.error(e instanceof Error ? e.message : 'No se pudo activar la tienda');
    }
  }

  return (
    <div className="adm-page" style={{ maxWidth: 640 }}>
      <p className="ek-eyebrow">COMPLEMENTO</p>
      <h1 className="ek-h1" style={{ marginBottom: 8 }}>Tienda</h1>
      <p className="ek-body-muted" style={{ marginTop: 0 }}>
        Vendé productos —agua, proteína, ropa— desde tu recepción y desde la app,
        con el stock y el corte de caja resueltos.
      </p>

      <div
        style={{
          background: 'var(--ek-bg-soft)',
          border: '1px solid var(--ek-line)',
          borderRadius: 16,
          padding: 24,
          margin: '20px 0'
        }}
      >
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9, color: 'var(--ek-ink)' }}>
          <li>Carga tus productos con precio, stock y foto</li>
          <li>Cóbralo en recepción: efectivo, terminal o tarjeta</li>
          <li>El stock se descuenta solo y todo entra a tu Caja</li>
          <li>Reporte de ventas del día y aviso de stock bajo</li>
        </ul>

        <div style={{ borderTop: '1px solid var(--ek-line)', margin: '20px 0 16px' }} />

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 30, fontWeight: 800, color: 'var(--ek-ink)' }}>$690</span>
          <span className="ek-body-muted">/mes por sucursal</span>
        </div>
        <p className="ek-body-muted" style={{ fontSize: 13, marginTop: 6 }}>
          Se suma a tu plan y se cobra a la misma tarjeta. Lo cancelás cuando quieras.
        </p>
      </div>

      <button
        className="ek-cta ek-lift"
        onClick={activar}
        disabled={estado !== 'idle'}
        style={{ minHeight: 48, padding: '0 28px', fontSize: 15 }}
      >
        {estado === 'idle' ? 'Activar la tienda' : estado === 'activando' ? 'Procesando…' : 'Activando…'}
      </button>

      {estado === 'esperando' && (
        <p className="ek-body-muted" style={{ fontSize: 13, marginTop: 12 }}>
          El cobro entró. Tu tienda se prende en unos segundos; si no aparece sola,
          recargá la página.
        </p>
      )}
    </div>
  );
}
