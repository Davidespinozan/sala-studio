import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { formatearMoneda } from '@shared/lib/dinero';

export interface PlanElegido {
  id: string;
  nombre: string;
  precio_centavos: number;
}

/**
 * El plan que el socio vio/eligió al registrarse y no pagó. Queda en
 * usuarios.membresia_tier (slug) mientras no tiene membresía. Solo si el tier
 * sigue activo; si no, null (se elige a mano).
 */
export function usePlanElegido(tenantId: string, slug: string | null | undefined, enabled = true) {
  const [plan, setPlan] = useState<PlanElegido | null>(null);
  useEffect(() => {
    if (!enabled || !slug) { setPlan(null); return; }
    let cancel = false;
    (async () => {
      const { data } = await supabase
        .from('tiers')
        .select('id, nombre, precio_centavos')
        .eq('tenant_id', tenantId)
        .eq('slug', slug)
        .eq('activo', true)
        .maybeSingle();
      if (!cancel) setPlan((data as PlanElegido | null) ?? null);
    })();
    return () => { cancel = true; };
  }, [tenantId, slug, enabled]);
  return plan;
}

/**
 * Aviso del perfil de un socio SIN plan (status 'pendiente_pago': se registró y
 * nunca compró). Antes el perfil solo decía "Pendiente pago" sin explicar qué se
 * debía ni cómo cobrarlo — y en realidad no debe nada: no hay cargo ni monto,
 * falta elegir y pagar un plan. El botón abre el alta de plan (que registra el
 * cobro en la Caja), con el plan que eligió al registrarse ya puesto.
 */
export function AvisoSinPlan({
  registradoAt,
  planElegido,
  onAsignar
}: {
  registradoAt: string | null;
  planElegido: PlanElegido | null;
  onAsignar: () => void;
}) {
  const fecha = registradoAt
    ? new Date(registradoAt).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' })
    : null;
  return (
    <div
      className="ek-card ek-card--md"
      style={{ marginBottom: '16px', border: '1px solid var(--sala-primary)', display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}
    >
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: '0 0 4px' }}>SIN PLAN</p>
        <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: 'var(--sala-text-primary)' }}>
          {fecha ? `Se registró el ${fecha} y todavía no tiene plan.` : 'Todavía no tiene plan.'}
        </p>
        <p style={{ margin: '4px 0 0', fontSize: '12.5px', lineHeight: 1.45, color: 'var(--sala-text-secondary)' }}>
          No debe nada aún: no ha comprado ni pagado ningún plan.
          {planElegido && (
            <>
              {' '}Al registrarse eligió <strong style={{ color: 'var(--sala-text-primary)' }}>{planElegido.nombre}</strong>
              {planElegido.precio_centavos > 0 ? ` (${formatearMoneda(planElegido.precio_centavos)})` : ''}.
            </>
          )}
          {' '}Cuando pague, asígnale su plan y el cobro queda en la Caja.
        </p>
      </div>
      <button type="button" onClick={onAsignar} className="ek-cta" style={{ fontSize: '13px', whiteSpace: 'nowrap' }}>
        Asignar plan y cobrar
      </button>
    </div>
  );
}
