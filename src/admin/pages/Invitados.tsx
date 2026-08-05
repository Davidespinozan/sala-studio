import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { fromZonedTime } from 'date-fns-tz';
import { UserPlus } from 'lucide-react';
import { getTenantTimezone, hoyEnTimezone, formatHoraEnTz, fechaEnTz } from '@shared/lib/timezone';
import { EmptyState } from '@shared/components/EmptyState';

/**
 * "Invitados del mes" — cada invitado que un socio trajo es un PROSPECTO: ya fue
 * al gym, se le puede convertir en socio. Muestra sus datos + qué clase, quién lo
 * trajo, y (si dio) la foto de INE (bucket privado → signed URL al abrir).
 */
interface InvitadoRow {
  id: string;
  nombre: string;
  telefono: string | null;
  email: string | null;
  created_at: string;
  reserva: {
    slot_inicio: string | null;
    recurso: { nombre: string | null } | null;
    usuario: { nombre: string | null; email: string | null } | null;
  } | null;
}

export default function Invitados() {
  const tenant = useTenant();
  const toast = useToast();
  const tz = getTenantTimezone(tenant);
  const [rows, setRows] = useState<InvitadoRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    void (async () => {
      // Primer día del mes en la zona del gym (no la del navegador).
      const hoyISO = hoyEnTimezone(tz);
      const inicioMes = fromZonedTime(`${hoyISO.slice(0, 8)}01T00:00:00`, tz).toISOString();

      // reserva_invitados aún no está en los tipos generados → cast acotado.
      const from = supabase.from.bind(supabase) as unknown as (t: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            gte: (col: string, val: string) => {
              order: (col: string, o: { ascending: boolean }) => Promise<{ data: unknown; error: { message: string } | null }>;
            };
          };
        };
      };
      const { data, error } = await from('reserva_invitados')
        .select(
          'id, nombre, telefono, email, created_at, ' +
          'reserva:reservas(slot_inicio, recurso:recursos(nombre), usuario:usuarios!reservas_usuario_id_fkey(nombre, email))'
        )
        .eq('tenant_id', tenant.id)
        .gte('created_at', inicioMes)
        .order('created_at', { ascending: false });

      if (!mounted) return;
      if (error) toast.error('No pudimos cargar los invitados.');
      setRows((data ?? []) as InvitadoRow[]);
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [tenant.id, tz, toast]);

  return (
    <div className="adm-page">
      <p className="adm-eyebrow" style={{ color: 'var(--sala-primary)', fontWeight: 700, letterSpacing: '.14em', fontSize: '11px', textTransform: 'uppercase', margin: '0 0 4px' }}>
        PROSPECTOS
      </p>
      <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '26px', fontWeight: 700, letterSpacing: '-0.02em', margin: '0 0 6px', color: 'var(--sala-text-primary)' }}>
        Invitados del mes
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--sala-text-secondary)', margin: '0 0 22px', maxWidth: '640px' }}>
        Cada invitado ya vino al gym — es un prospecto para convertir en socio. Aquí están sus datos,
        qué clase tomaron y quién los trajo.
      </p>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {[1, 2, 3].map((n) => <div key={n} className="ek-skeleton" style={{ height: '68px', borderRadius: '12px' }} />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="Sin invitados este mes"
          subtitle="Cuando un socio traiga un invitado (desde su app o en recepción), aparecerá aquí como prospecto."
        />
      ) : (
        <>
          <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', margin: '0 0 12px' }}>
            {rows.length} {rows.length === 1 ? 'invitado' : 'invitados'} este mes
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {rows.map((r) => {
              const clase = r.reserva?.recurso?.nombre ?? 'Clase';
              const cuando = r.reserva?.slot_inicio
                ? `${fechaEnTz(new Date(r.reserva.slot_inicio), tz)} · ${formatHoraEnTz(new Date(r.reserva.slot_inicio), tz)}`
                : '—';
              const socio = r.reserva?.usuario?.nombre ?? r.reserva?.usuario?.email ?? 'un socio';
              return (
                <div key={r.id} style={{ border: '1px solid var(--sala-border)', borderRadius: '14px', background: 'var(--sala-surface)', padding: '14px 16px', display: 'flex', gap: '14px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: '200px' }}>
                    <p style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: 'var(--sala-text-primary)' }}>{r.nombre}</p>
                    <p style={{ margin: '3px 0 0', fontSize: '13px', color: 'var(--sala-text-secondary)' }}>
                      {r.telefono
                        ? <a href={`tel:${r.telefono}`} style={{ color: 'var(--sala-primary)', fontWeight: 600, textDecoration: 'none' }}>{r.telefono}</a>
                        : <span style={{ color: 'var(--sala-text-tertiary)' }}>Sin teléfono</span>}
                      {r.email && <span style={{ color: 'var(--sala-text-tertiary)' }}> · {r.email}</span>}
                    </p>
                    <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--sala-text-tertiary)' }}>
                      {clase} · {cuando} · lo trajo <strong style={{ color: 'var(--sala-text-secondary)', fontWeight: 600 }}>{socio}</strong>
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
