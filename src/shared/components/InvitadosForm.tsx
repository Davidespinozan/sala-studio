import { type InvitadoDetalle, invitadoVacio } from '@shared/lib/invitados';

/**
 * Captura los datos de los N invitados de una reserva (nombre/teléfono/email +
 * foto de INE opcional). Controlado: el padre mantiene la lista y la sincroniza
 * con el conteo. Se usa igual en la app del socio y en recepción.
 */
export function InvitadosForm({
  count,
  value,
  onChange
}: {
  count: number;
  value: InvitadoDetalle[];
  onChange: (v: InvitadoDetalle[]) => void;
}) {
  if (count <= 0) return null;

  function set(i: number, patch: Partial<InvitadoDetalle>) {
    const base = value.length >= count ? value : Array.from({ length: count }, (_, k) => value[k] ?? invitadoVacio());
    onChange(base.map((g, idx) => (idx === i ? { ...g, ...patch } : g)));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '18px' }}>
      <p style={{ fontSize: '12px', color: 'var(--sala-text-tertiary)', margin: 0, lineHeight: 1.4 }}>
        Datos de {count === 1 ? 'tu invitado' : 'tus invitados'}.
      </p>
      {Array.from({ length: count }).map((_, i) => {
        const g = value[i] ?? invitadoVacio();
        return (
          <div
            key={i}
            style={{
              border: '1px solid var(--sala-border)', borderRadius: '12px',
              padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px'
            }}
          >
            <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--sala-text-secondary)' }}>
              Invitado {i + 1}
            </span>
            <input
              className="ek-input"
              placeholder="Nombre completo *"
              value={g.nombre}
              onChange={(e) => set(i, { nombre: e.target.value })}
            />
            <input
              className="ek-input"
              placeholder="Teléfono"
              inputMode="tel"
              value={g.telefono}
              onChange={(e) => set(i, { telefono: e.target.value })}
            />
            <input
              className="ek-input"
              placeholder="Email (opcional)"
              inputMode="email"
              value={g.email}
              onChange={(e) => set(i, { email: e.target.value })}
            />
          </div>
        );
      })}
    </div>
  );
}