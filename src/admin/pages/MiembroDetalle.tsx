import { useParams, Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useMiembroDetalle, updateMiembro, adminUpdateRole } from '../hooks/useAdminData';
import { supabase } from '@shared/lib/supabase';
import { formatHora } from '@member/logic/reservaLogic';
import type { Database } from '@shared/types/database';

export default function MiembroDetalle() {
  const { id } = useParams<{ id: string }>();
  const { miembro, reservas, isLoading, refetch } = useMiembroDetalle(id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ status: string; membresia_tier: string }>({
    status: '',
    membresia_tier: ''
  });

  useEffect(() => {
    if (miembro) {
      setDraft({ status: miembro.status, membresia_tier: miembro.membresia_tier ?? '' });
    }
  }, [miembro]);

  if (isLoading) return <p className="adm-body">Cargando…</p>;
  if (!miembro) return <p className="adm-body">Miembro no encontrado.</p>;

  async function handleSave() {
    setSaving(true);
    setError(null);
    const { error: err } = await updateMiembro(miembro!.id, {
      status: draft.status as any,
      membresia_tier: draft.membresia_tier || null
    });
    if (err) {
      setError(err);
    } else {
      await refetch();
    }
    setSaving(false);
  }

  return (
    <div className="adm-page">
      <Link to="/admin/miembros" className="adm-link">← Volver</Link>

      <div className="adm-page-header" style={{ marginTop: '1rem' }}>
        <p className="ek-eyebrow">MIEMBRO</p>
        <h1 className="ek-h2">{miembro.nombre ?? miembro.email}</h1>
      </div>

      <section className="adm-section">
        <h2 className="ek-h3">Datos del miembro</h2>
        <EditarDatosForm
          miembro={miembro}
          onSaved={refetch}
        />
      </section>

      <section className="adm-section">
        <h2 className="ek-h3">Información del sistema</h2>
        <div className="adm-info-grid">
          <Info label="Email" value={miembro.email} />
          <Info label="Rol" value={miembro.rol} mono />
          <Info label="Alta" value={new Date(miembro.created_at).toLocaleString('es-MX')} />
          {miembro.commitment_ends_at && (
            <Info label="Commitment hasta" value={new Date(miembro.commitment_ends_at).toLocaleDateString('es-MX')} />
          )}
          {miembro.bloqueado_hasta && new Date(miembro.bloqueado_hasta) > new Date() && (
            <Info label="Bloqueado hasta" value={new Date(miembro.bloqueado_hasta).toLocaleString('es-MX')} />
          )}
          <Info label="No-shows" value={miembro.no_shows_count} />
        </div>
        <ResetPasswordControl email={miembro.email} />
      </section>

      <section className="adm-section">
        <h2 className="ek-h3">Acciones</h2>
        <div className="adm-form-row">
          <label className="ek-label">
            Status
            <select
              value={draft.status}
              onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
              className="ek-input"
            >
              <option value="pendiente_onboarding">pendiente_onboarding</option>
              <option value="pendiente_pago">pendiente_pago</option>
              <option value="activo">activo</option>
              <option value="suspendido">suspendido</option>
              <option value="cancelado">cancelado</option>
            </select>
          </label>
          <label className="ek-label">
            Tier
            <select
              value={draft.membresia_tier}
              onChange={(e) => setDraft((d) => ({ ...d, membresia_tier: e.target.value }))}
              className="ek-input"
            >
              <option value="">— sin tier —</option>
              <option value="basica">basica</option>
              <option value="pro">pro</option>
            </select>
          </label>
        </div>
        {error && <p className="ek-error-text">{error}</p>}
        <button onClick={handleSave} disabled={saving} className="ek-cta" style={{ marginTop: '1rem', alignSelf: 'flex-start' }}>
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </section>

      <section className="adm-section">
        <h2 className="ek-h3">Rol</h2>
        <p className="adm-body">
          Rol actual: <RolBadge rol={miembro.rol} />
        </p>
        <CambiarRolControl
          usuarioId={miembro.id}
          rolActual={miembro.rol}
          onChanged={refetch}
        />
      </section>

      <section className="adm-section">
        <h2 className="ek-h3">Foto del miembro</h2>
        <AvatarUploadControl
          usuarioId={miembro.id}
          avatarUrl={miembro.avatar_url}
          onChanged={refetch}
        />
      </section>

      <section className="adm-section">
        <h2 className="ek-h3">Notas operativas</h2>
        <p className="adm-body" style={{ marginBottom: '0.5rem' }}>
          Visible para recepción al hacer check-in. Útil para preferencias,
          equipo solicitado, observaciones del miembro.
        </p>
        <NotasControl
          usuarioId={miembro.id}
          notasIniciales={(miembro as { notas_admin?: string | null }).notas_admin ?? null}
          onSaved={refetch}
        />
      </section>

      <section className="adm-section">
        <h2 className="ek-h3">Reservas ({reservas.length})</h2>
        {reservas.length === 0 ? (
          <p className="adm-body">Sin reservas.</p>
        ) : (
          <div className="adm-table-wrapper">
            <table className="adm-table">
              <thead>
                <tr><th>Folio</th><th>Fecha</th><th>Estudio</th><th>Status</th></tr>
              </thead>
              <tbody>
                {reservas.map((r) => (
                  <tr key={r.id}>
                    <td><code style={{ fontFamily: 'var(--ek-font-mono)' }}>{r.folio}</code></td>
                    <td>
                      {new Date(r.slot_inicio).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}
                      {' · '}
                      {formatHora(new Date(r.slot_inicio))}
                    </td>
                    <td>{r.recurso?.nombre ?? '—'}</td>
                    <td><code style={{ fontFamily: 'var(--ek-font-mono)' }}>{r.status}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="adm-info-label">{label}</p>
      <p className="adm-info-value" style={mono ? { fontFamily: 'var(--ek-font-mono)' } : undefined}>
        {value}
      </p>
    </div>
  );
}

function RolBadge({ rol }: { rol: string }) {
  return <code style={{ fontFamily: 'var(--ek-font-mono)', background: 'var(--ek-cream-deep)', padding: '2px 8px', borderRadius: '4px' }}>{rol}</code>;
}

function CambiarRolControl({ usuarioId, rolActual, onChanged }: {
  usuarioId: string;
  rolActual: string;
  onChanged: () => Promise<void>;
}) {
  const [nuevoRol, setNuevoRol] = useState<'miembro' | 'recepcionista' | 'staff' | 'admin'>(rolActual as any);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);

  async function handleSave() {
    if (nuevoRol === rolActual) return;
    if (nuevoRol === 'admin' && !needsConfirm) {
      setNeedsConfirm(true);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await adminUpdateRole({ usuario_id: usuarioId, rol: nuevoRol });
      await onChanged();
      setNeedsConfirm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cambiando rol');
    }
    setSaving(false);
  }

  return (
    <div className="adm-form-row" style={{ marginTop: '0.5rem' }}>
      <label className="ek-label" style={{ flex: 1 }}>
        Nuevo rol
        <select
          value={nuevoRol}
          onChange={(e) => setNuevoRol(e.target.value as any)}
          className="ek-input"
        >
          <option value="miembro">Miembro</option>
          <option value="recepcionista">Recepción</option>
          <option value="staff">Staff</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <button
        onClick={handleSave}
        disabled={saving || nuevoRol === rolActual}
        className="ek-cta"
        style={{ alignSelf: 'flex-end' }}
      >
        {saving ? '…' : needsConfirm && nuevoRol === 'admin' ? 'Confirmar admin' : 'Cambiar rol'}
      </button>
      {error && <p className="ek-error-text">{error}</p>}
      {needsConfirm && nuevoRol === 'admin' && (
        <p style={{ fontSize: '0.8125rem', color: 'var(--ek-danger)', flexBasis: '100%', marginTop: '0.5rem' }}>
          ⚠️ Promover a admin da acceso TOTAL al negocio. Click "Confirmar admin" para proceder.
        </p>
      )}
    </div>
  );
}

function AvatarUploadControl({ usuarioId, avatarUrl, onChanged }: {
  usuarioId: string;
  avatarUrl: string | null;
  onChanged: () => Promise<void>;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `${usuarioId}/${Date.now()}.${ext}`;

      const { error: uploadErr } = await supabase.storage
        .from('avatars')
        .upload(path, file, { cacheControl: '3600', upsert: false });

      if (uploadErr) throw uploadErr;

      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);

      const { error: updateErr } = await supabase
        .from('usuarios')
        .update({ avatar_url: publicUrl })
        .eq('id', usuarioId);

      if (updateErr) throw updateErr;

      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error subiendo foto');
    }
    setUploading(false);
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="Avatar" style={{
          width: '80px', height: '80px', borderRadius: '50%', objectFit: 'cover',
          border: '1px solid var(--ek-line)'
        }} />
      ) : (
        <div style={{
          width: '80px', height: '80px', borderRadius: '50%',
          background: 'var(--ek-cream-deep)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: 'var(--ek-ink-muted)', fontSize: '0.875rem'
        }}>
          Sin foto
        </div>
      )}
      <label className="ek-cta ek-cta--secondary" style={{ cursor: 'pointer' }}>
        {uploading ? 'Subiendo…' : avatarUrl ? 'Cambiar foto' : 'Subir foto'}
        <input
          type="file"
          accept="image/*"
          disabled={uploading}
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          style={{ display: 'none' }}
        />
      </label>
      {error && <p className="ek-error-text">{error}</p>}
    </div>
  );
}

function EditarDatosForm({ miembro, onSaved }: {
  miembro: Database['public']['Tables']['usuarios']['Row'];
  onSaved: () => Promise<void>;
}) {
  const [nombre, setNombre] = useState(miembro.nombre ?? '');
  const [telefono, setTelefono] = useState(miembro.telefono ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDirty = (nombre !== (miembro.nombre ?? '')) || (telefono !== (miembro.telefono ?? ''));

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const { error } = await supabase
        .from('usuarios')
        .update({
          nombre: nombre.trim() || null,
          telefono: telefono.trim() || null
        })
        .eq('id', miembro.id);
      if (error) throw error;
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error guardando');
    }
    setSaving(false);
  }

  return (
    <div className="adm-info-grid" style={{ background: 'transparent', padding: 0, border: 'none' }}>
      <label className="ek-label">
        Nombre
        <input
          type="text"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          className="ek-input"
          placeholder="Nombre completo"
        />
      </label>
      <label className="ek-label">
        Teléfono
        <input
          type="tel"
          value={telefono}
          onChange={(e) => setTelefono(e.target.value)}
          className="ek-input"
          placeholder="+52 667 123 4567"
        />
      </label>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.75rem', gridColumn: '1 / -1' }}>
        <button
          onClick={handleSave}
          disabled={saving || !isDirty}
          className="ek-cta"
        >
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </button>
        {saved && <span style={{ color: 'var(--ek-success)', fontSize: '0.875rem' }}>✓ Guardado</span>}
        {error && <span style={{ color: 'var(--ek-danger)', fontSize: '0.875rem' }}>{error}</span>}
      </div>
    </div>
  );
}

function ResetPasswordControl({ email }: { email: string }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReset() {
    if (!confirm(`¿Enviar email de recuperación de contraseña a ${email}?`)) return;
    setSending(true);
    setError(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/login`
      });
      if (error) throw error;
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error enviando');
    }
    setSending(false);
  }

  if (sent) {
    return (
      <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: 'var(--ek-success)' }}>
        ✓ Email de recuperación enviado a {email}
      </p>
    );
  }

  return (
    <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
      <button onClick={handleReset} disabled={sending} className="ek-cta ek-cta--secondary">
        {sending ? 'Enviando…' : 'Enviar email de recuperación de contraseña'}
      </button>
      {error && <span style={{ color: 'var(--ek-danger)', fontSize: '0.875rem' }}>{error}</span>}
    </div>
  );
}

function NotasControl({ usuarioId, notasIniciales, onSaved }: {
  usuarioId: string;
  notasIniciales: string | null;
  onSaved: () => Promise<void>;
}) {
  const [notas, setNotas] = useState(notasIniciales ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const { error } = await supabase
        .from('usuarios')
        .update({ notas_admin: notas.trim() || null } as never)
        .eq('id', usuarioId);
      if (error) throw error;
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error guardando');
    }
    setSaving(false);
  }

  return (
    <div className="ek-stack-md">
      <textarea
        value={notas}
        onChange={(e) => setNotas(e.target.value)}
        maxLength={500}
        rows={4}
        placeholder="Ej. Suele grabar podcasts largos. Prefiere micrófono Shure. Acompañado de 1 editor."
        className="ek-input"
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <p style={{ fontSize: '0.75rem', color: 'var(--ek-ink-muted)' }}>
          {notas.length}/500 caracteres
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {saved && <span style={{ color: 'var(--ek-success)', fontSize: '0.875rem' }}>✓ Guardado</span>}
          {error && <span style={{ color: 'var(--ek-danger)', fontSize: '0.875rem' }}>{error}</span>}
          <button onClick={handleSave} disabled={saving} className="ek-cta">
            {saving ? 'Guardando…' : 'Guardar notas'}
          </button>
        </div>
      </div>
    </div>
  );
}
