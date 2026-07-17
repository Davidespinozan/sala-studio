import { useCallback, useState, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { formatearMoneda } from '@shared/lib/dinero';
import { ActivarCobrosCard } from '../components/ActivarCobrosCard';
import type { ConnectEstado } from '../lib/connectService';

/**
 * COBROS — la conexión con Stripe para cobrarle a tus socios (Stripe Connect).
 *
 * Vivía enterrada al final de la página de Suscripción, que es OTRA cosa: ahí el
 * gym paga SU plan a SALA. Mezclar "lo que yo le pago a SALA" con "cómo le cobro
 * a mis socios" confundía las dos direcciones del dinero. Ahora es su propia
 * pestaña, al lado de Suscripción.
 *
 * Con la cuenta conectada, el dueño ve SUS datos: a qué banco le depositan, cada
 * cuánto, cuánto tiene disponible y cuánto viene en camino, más el link a su
 * panel de Stripe. Antes solo veía "activo" — para saber cualquier cosa de su
 * propio dinero tenía que entrar a Stripe por su cuenta y encontrarlo solo.
 */

const INTERVALO_LABEL: Record<string, string> = {
  daily: 'Diaria',
  weekly: 'Semanal',
  monthly: 'Mensual',
  manual: 'Manual (los pedís vos)'
};

function intervaloLabel(i: string | null | undefined): string {
  if (!i) return '—';
  return INTERVALO_LABEL[i] ?? i;
}

/** acct_1A2B3C4D5E6F → acct_…5E6F. El id completo no le dice nada al dueño. */
function idCorto(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 5)}…${id.slice(-4)}` : id;
}

function Fila({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: '16px',
        padding: '7px 0'
      }}
    >
      <span style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', flexShrink: 0 }}>{label}</span>
      <span
        style={{
          fontSize: '13.5px',
          fontWeight: 600,
          color: 'var(--sala-text-primary)',
          textAlign: 'right',
          minWidth: 0,
          wordBreak: 'break-word',
          fontFamily: mono ? 'ui-monospace, Menlo, monospace' : undefined
        }}
      >
        {value}
      </span>
    </div>
  );
}

function Bloque({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderRadius: '16px',
        padding: '20px'
      }}
    >
      <p className="ek-eyebrow" style={{ margin: '0 0 8px' }}>{titulo}</p>
      {children}
    </div>
  );
}

export default function Cobros() {
  const [estado, setEstado] = useState<ConnectEstado | null>(null);
  // Estable: si no, ActivarCobrosCard reejecutaría su efecto en cada render.
  const recibirEstado = useCallback((e: ConnectEstado | null) => setEstado(e), []);

  const conectado = estado?.connected === true;

  return (
    <div className="adm-page">
      <p className="ek-eyebrow" style={{ marginBottom: '4px' }}>CUENTA</p>
      <h1
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(28px, 5vw, 40px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          margin: 0,
          marginBottom: '6px'
        }}
      >
        Cobros
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '24px', lineHeight: 1.55 }}>
        Cómo le cobrás a tus socios. El dinero va directo a tu cuenta bancaria — SALA nunca lo toca.
        Para ver los cobros que ya entraron, andá a <strong>Caja</strong>.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <ActivarCobrosCard onEstado={recibirEstado} />

        {conectado && (
          <>
            <Bloque titulo="CUENTA VINCULADA">
              <Fila label="Negocio" value={estado?.business_name || '—'} />
              <Fila label="Email" value={estado?.email || '—'} />
              <Fila label="País" value={estado?.pais || '—'} />
              <Fila label="ID de cuenta" value={idCorto(estado?.account_id)} mono />
            </Bloque>

            <Bloque titulo="DEPÓSITOS A TU BANCO">
              <Fila
                label="Cuenta bancaria"
                value={
                  estado?.bank
                    ? `${estado.bank.bank_name ?? 'Banco'} ••••${estado.bank.last4 ?? '????'}`
                    : 'Sin cuenta cargada'
                }
              />
              <Fila label="Frecuencia" value={intervaloLabel(estado?.payout_interval)} />
              <Fila
                label="Depósitos habilitados"
                value={
                  <span style={{ color: estado?.payouts_enabled ? 'var(--sala-success)' : 'var(--sala-warning)' }}>
                    {estado?.payouts_enabled ? 'Sí' : 'Todavía no'}
                  </span>
                }
              />
            </Bloque>

            {estado?.balance && (
              <Bloque titulo="TU SALDO EN STRIPE">
                <Fila
                  label="Disponible"
                  value={formatearMoneda(estado.balance.disponible_centavos, estado.balance.moneda)}
                />
                <Fila
                  label="En camino"
                  value={formatearMoneda(estado.balance.pendiente_centavos, estado.balance.moneda)}
                />
                <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: '8px 0 0', lineHeight: 1.5 }}>
                  “En camino” es plata ya cobrada que Stripe todavía está liberando; cae a tu banco
                  según la frecuencia de arriba.
                </p>
              </Bloque>
            )}

            <Bloque titulo="ADMINISTRAR">
              <p style={{ fontSize: '13px', color: 'var(--sala-text-secondary)', margin: '0 0 12px', lineHeight: 1.55 }}>
                En tu panel de Stripe cambiás la cuenta bancaria, ves cada depósito, gestionás
                disputas y descargás reportes.
              </p>
              {estado?.dashboard_url ? (
                <a
                  href={estado.dashboard_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ek-cta"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  Abrir mi panel de Stripe <ExternalLink size={14} aria-hidden="true" />
                </a>
              ) : (
                <p style={{ fontSize: '13px', color: 'var(--sala-text-tertiary)', margin: 0 }}>
                  El link a tu panel no está disponible ahora. Reintentá en un rato.
                </p>
              )}
            </Bloque>
          </>
        )}
      </div>
    </div>
  );
}
