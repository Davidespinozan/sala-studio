import { useState } from 'react';
import { ShieldAlert, Lock } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useNotificaciones } from '@shared/hooks/useNotificaciones';

/**
 * Aviso EN PANTALLA (fuerte, tono de precaución) para que el DUEÑO de la cuenta
 * cambie la contraseña TEMPORAL con la que entró (Cambiar123). Se dispara con la
 * notificación `cambiar_password` (que también vive en la campana), que insertan
 * las funciones de alta/reset. Cada quien cambia la SUYA: aplica igual a miembros
 * y a staff (recepción/admin). Mientras no la cambie reaparece en cada entrada,
 * pero deja seguir usando la app ("Ahora no"). Al cambiarla, se marca leída y
 * desaparece.
 *
 * Montado en los 3 layouts (member, admin, reception).
 */
export function CambiarPasswordGate() {
  const { items, marcarLeida } = useNotificaciones();
  const aviso = items.find((n) => n.tipo === 'cambiar_password' && !n.leida);

  const [pospuesto, setPospuesto] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!aviso || pospuesto) return null;

  const larga = password.length >= 8;
  const coincide = password === confirm;
  const puede = larga && coincide && !saving;

  async function cambiar() {
    if (!puede || !aviso) return;
    setSaving(true);
    setError(null);
    const { error: e } = await supabase.auth.updateUser({ password });
    if (e) {
      setError(e.message.includes('should be different') ? 'Elige una contraseña distinta a la temporal.' : 'No se pudo cambiar. Intenta de nuevo.');
      setSaving(false);
      return;
    }
    await marcarLeida(aviso.id);
    setSaving(false);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        background: 'rgba(60, 10, 10, 0.6)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        animation: 'ek-fade-in 0.18s ease'
      }}
    >
      <div
        style={{
          background: 'var(--sala-bg)', width: '100%', maxWidth: '420px',
          borderRadius: 'var(--ek-r-card, 18px)', padding: '28px 24px',
          border: '1px solid var(--sala-error)',
          boxShadow: '0 0 0 4px rgba(220,38,38,0.15), 0 20px 60px rgba(0,0,0,0.4)',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: '18px' }}>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex', width: 52, height: 52, borderRadius: '14px',
              alignItems: 'center', justifyContent: 'center', marginBottom: '14px',
              background: 'var(--sala-error-bg, rgba(220,38,38,0.12))', color: 'var(--sala-error)'
            }}
          >
            <ShieldAlert size={26} strokeWidth={2.25} />
          </span>
          <p style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.14em', color: 'var(--sala-error)', margin: 0 }}>
            IMPORTANTE · SEGURIDAD
          </p>
          <h2 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '22px', fontWeight: 700, letterSpacing: '-0.02em', margin: '6px 0 8px', color: 'var(--sala-text-primary)' }}>
            Cambia tu contraseña ahora
          </h2>
          <p style={{ fontSize: '13.5px', color: 'var(--sala-text-secondary)', lineHeight: 1.55, margin: 0 }}>
            Entraste con una contraseña <strong>temporal</strong>. Cámbiala por una
            <strong> tuya</strong> para que nadie más pueda entrar a tu cuenta.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '14px' }}>
          <label className="ek-label" style={{ display: 'block' }}>
            <span style={{ display: 'block', marginBottom: '5px' }}>Nueva contraseña</span>
            <input
              className="ek-input" type="password" value={password} autoFocus
              onChange={(e) => setPassword(e.target.value)} placeholder="Mínimo 8 caracteres" autoComplete="new-password"
            />
          </label>
          <label className="ek-label" style={{ display: 'block' }}>
            <span style={{ display: 'block', marginBottom: '5px' }}>Repite la contraseña</span>
            <input
              className="ek-input" type="password" value={confirm}
              onChange={(e) => setConfirm(e.target.value)} placeholder="La misma otra vez" autoComplete="new-password"
            />
          </label>
          {confirm.length > 0 && !coincide && (
            <p style={{ fontSize: '12px', color: 'var(--sala-error)', margin: 0 }}>No coinciden.</p>
          )}
          {error && <p style={{ fontSize: '12.5px', color: 'var(--sala-error)', margin: 0 }}>{error}</p>}
        </div>

        <button
          type="button" onClick={cambiar} disabled={!puede}
          className="ek-cta ek-cta--full"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px', opacity: puede ? 1 : 0.5 }}
        >
          <Lock size={16} strokeWidth={2.5} />
          {saving ? 'Guardando…' : 'Guardar mi contraseña'}
        </button>
        <button
          type="button" onClick={() => setPospuesto(true)}
          style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12.5px', color: 'var(--sala-text-tertiary)', marginTop: '12px' }}
        >
          Ahora no (te lo recordaremos)
        </button>
      </div>
    </div>
  );
}