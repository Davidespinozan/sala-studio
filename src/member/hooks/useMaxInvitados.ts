import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';

/**
 * Máximo de invitados que el plan del socio permite. Nada hardcodeado: sale de
 * tiers.reglas.max_invitados (editable por el admin en Planes), por tenant.
 * El gate del backend (reservar_clase_atomic) usa la misma fuente. 0 si el plan
 * no lo definió o el socio no tiene tier.
 */
export function useMaxInvitados(): number {
  const { usuario } = useAuth();
  const tenant = useTenant();
  const [max, setMax] = useState(0);

  useEffect(() => {
    const slug = usuario?.membresia_tier;
    if (!slug) { setMax(0); return; }
    let mounted = true;
    supabase
      .from('tiers')
      .select('reglas')
      .eq('tenant_id', tenant.id)
      .eq('slug', slug)
      .maybeSingle()
      .then(({ data }) => {
        if (!mounted) return;
        const m = (data?.reglas as { max_invitados?: number } | null)?.max_invitados;
        setMax(typeof m === 'number' && m > 0 ? m : 0);
      });
    return () => { mounted = false; };
  }, [usuario?.membresia_tier, tenant.id]);

  return max;
}
