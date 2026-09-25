import { useEffect, useState } from 'react';
import { TenantLogo } from '@shared/components/TenantLogo';
import { useTenant } from '@shared/hooks/useTenant';
import { useLandingConfig } from '@shared/hooks/useLandingConfig';
import { socioPuedePagarEnApp } from '@shared/lib/cobrosDelGym';
import { autoservicioActivo } from '@shared/lib/cobrosConfig';
import { formatearPrecioTier, sufijoPeriodoTier } from '@shared/lib/precioTier';
import { supabase } from '@shared/lib/supabase';
import { CheckoutModal } from '@shared/components/CheckoutModal';

interface TierRow {
  id: string;
  slug: string;
  nombre: string;
  precio_centavos: number;
  moneda: string;
  tipo: string | null;
  periodo: string | null;
  clases_incluidas: number | null;
  duracion_dias: number | null;
}

/**
 * Socio con status 'pendiente_pago': cuenta creada, falta plan/pago.
 *
 * Dos casos:
 *  (a) Con plan preseleccionado (`tierSlug`, alta con plan): si el gym cobra online
 *      abre directo el checkout de ese plan; si no, "paga/coordina en recepción".
 *  (b) SIN plan (`tierSlug` vacío, alta sin plan): muestra el SELECTOR de planes.
 *      Online → elegir un plan abre el checkout. Recepción → lista informativa +
 *      "elige y paga en recepción" (recepción se lo asigna).
 */
export function MembresiaPendiente({
  nombre,
  tierSlug,
  onCerrarSesion,
}: {
  nombre: string | null;
  tierSlug?: string | null;
  onCerrarSesion: () => void;
}) {
  const tenant = useTenant();
  const { whatsappUrl } = useLandingConfig();
  const cobraOnline = socioPuedePagarEnApp(tenant);
  const autoservicio = autoservicioActivo(tenant.config as Record<string, unknown> | null);
  const sinPlan = !tierSlug;

  const [tierId, setTierId] = useState<string | null>(null);
  const [showCheckout, setShowCheckout] = useState(false);
  const [activando, setActivando] = useState(false);
  // Alta sin plan: planes para elegir.
  const [planes, setPlanes] = useState<TierRow[]>([]);
  const [cargandoPlanes, setCargandoPlanes] = useState(false);

  // Caso (a): resolver el tier preseleccionado y, si cobra online, abrir el checkout.
  useEffect(() => {
    if (!tierSlug) return;
    let cancelado = false;
    (async () => {
      const { data } = await supabase
        .from('tiers')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('slug', tierSlug)
        .eq('activo', true)
        .maybeSingle();
      if (cancelado) return;
      if (data?.id) {
        setTierId(data.id);
        if (cobraOnline) setShowCheckout(true);
      }
    })();
    return () => { cancelado = true; };
  }, [tierSlug, tenant.id, cobraOnline]);

  // Caso (b): sin plan → traer los planes publicados (misma regla que el signup).
  useEffect(() => {
    if (!sinPlan) return;
    let cancelado = false;
    setCargandoPlanes(true);
    (async () => {
      const { data } = await supabase
        .from('tiers')
        .select('id, slug, nombre, precio_centavos, moneda, tipo, periodo, clases_incluidas, duracion_dias')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .eq('en_venta', true)
        .eq('visible_landing', true)
        .order('precio_centavos', { ascending: true });
      if (cancelado) return;
      setPlanes((data ?? []) as TierRow[]);
      setCargandoPlanes(false);
    })();
    return () => { cancelado = true; };
  }, [sinPlan, tenant.id]);

  function handlePaid() {
    setShowCheckout(false);
    setActivando(true);
    // El webhook activa la membresía (1-2s) → recargamos para entrar ya activo.
    setTimeout(() => window.location.reload(), 1800);
  }

  function elegirPlan(id: string) {
    setTierId(id);
    setShowCheckout(true);
  }

  const wrap: React.CSSProperties = {
    minHeight: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: '24px',
    background: 'var(--ek-bg)',
  };

  if (activando) {
    return (
      <div style={wrap}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: '0 0 8px' }}>¡PAGO RECIBIDO!</p>
        <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: 20, fontWeight: 700, color: 'var(--ek-ink)', margin: 0 }}>
          Activando tu membresía…
        </p>
      </div>
    );
  }

  // ── Caso (b): SIN plan → selector de planes ───────────────────────────────
  if (sinPlan) {
    return (
      <>
        <div style={{ ...wrap, justifyContent: 'flex-start', paddingTop: 48 }}>
          <TenantLogo variant="completo" height={44} fallbackFontSize={28} showSuffix />
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: '24px 0 8px' }}>ELIGE TU PLAN</p>
          <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.15, margin: '0 0 10px', color: 'var(--ek-ink)' }}>
            {nombre ? `Hola, ${nombre}` : 'Tu cuenta está lista'}
          </h1>
          <p style={{ maxWidth: 400, fontSize: 14, color: 'var(--sala-text-secondary)', lineHeight: 1.55, margin: '0 0 22px' }}>
            {cobraOnline
              ? 'Elige un plan para activar tu membresía y empezar a reservar.'
              : autoservicio
                ? `Elige el plan que quieres y coordina el pago con ${tenant.nombre} para activarlo.`
                : `Elige el plan que quieres y págalo en recepción; ahí te lo activan para reservar.`}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 380 }}>
            {cargandoPlanes ? (
              <div className="ek-skeleton" style={{ height: 72, borderRadius: 'var(--ek-r-md)' }} />
            ) : planes.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--sala-text-secondary)' }}>
                {tenant.nombre} todavía no publicó sus planes. Escríbeles para más info.
              </p>
            ) : (
              planes.map((p) => (
                <div
                  key={p.id}
                  className="ek-card"
                  style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, textAlign: 'left' }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--sala-text-primary)' }}>{p.nombre}</div>
                    <div style={{ fontSize: 13, color: 'var(--sala-text-secondary)' }}>
                      {formatearPrecioTier(p.precio_centavos, p.moneda)}{sufijoPeriodoTier(p)}
                    </div>
                  </div>
                  {cobraOnline && (
                    <button onClick={() => elegirPlan(p.id)} className="ek-cta" style={{ flexShrink: 0 }}>
                      Elegir
                    </button>
                  )}
                </div>
              ))
            )}

            {!cobraOnline && whatsappUrl() && (
              <a
                href={whatsappUrl() as string}
                target="_blank"
                rel="noopener noreferrer"
                className="ek-cta"
                style={{ textDecoration: 'none', marginTop: 4 }}
              >
                Escríbele a {tenant.nombre}
              </a>
            )}
            <button onClick={onCerrarSesion} className="ek-cta ek-cta--secondary">
              Cerrar sesión
            </button>
          </div>
        </div>

        {showCheckout && tierId && (
          <CheckoutModal tierId={tierId} onClose={() => setShowCheckout(false)} onSuccess={handlePaid} />
        )}
      </>
    );
  }

  // ── Caso (a): plan preseleccionado ────────────────────────────────────────
  return (
    <>
      <div style={wrap}>
        <TenantLogo variant="completo" height={48} fallbackFontSize={30} showSuffix />
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: '26px 0 8px' }}>CASI LISTO</p>
        <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.15, margin: '0 0 10px', color: 'var(--ek-ink)' }}>
          {nombre ? `Hola, ${nombre}` : cobraOnline ? 'Completa tu pago' : 'Tu cuenta está lista'}
        </h1>
        <p style={{ maxWidth: 380, fontSize: 14, color: 'var(--sala-text-secondary)', lineHeight: 1.55, margin: '0 0 22px' }}>
          {cobraOnline
            ? 'Paga tu plan para activar tu membresía y empezar a reservar.'
            : autoservicio
              ? `Tu cuenta ya está creada. Coordina el pago con ${tenant.nombre} y activan tu membresía para que puedas reservar.`
              : `Tu cuenta ya está creada. Paga tu plan en recepción y activan tu membresía para que puedas reservar.`}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 300 }}>
          {cobraOnline && tierId && (
            <button onClick={() => setShowCheckout(true)} className="ek-cta">
              Pagar mi plan
            </button>
          )}
          {!cobraOnline && whatsappUrl() && (
            <a
              href={whatsappUrl() as string}
              target="_blank"
              rel="noopener noreferrer"
              className="ek-cta"
              style={{ textDecoration: 'none' }}
            >
              Escríbele a {tenant.nombre}
            </a>
          )}
          <button onClick={onCerrarSesion} className="ek-cta ek-cta--secondary">
            Cerrar sesión
          </button>
        </div>
      </div>

      {showCheckout && tierId && (
        <CheckoutModal tierId={tierId} onClose={() => setShowCheckout(false)} onSuccess={handlePaid} />
      )}
    </>
  );
}
