import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';

interface Props {
  usuarioId: string;
  notasIniciales: string | null;
  onSaved: () => Promise<void>;
}

export function MiembroNotasInternas({ usuarioId, notasIniciales, onSaved }: Props) {
  const toast = useToast();
  const [notas, setNotas] = useState(notasIniciales ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setNotas(notasIniciales ?? '');
  }, [notasIniciales]);

  const isDirty = notas !== (notasIniciales ?? '');

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    const { error } = await supabase
      .from('usuarios')
      .update({ notas_admin: notas.trim() || null } as never)
      .eq('id', usuarioId);
    setSaving(false);
    if (error) {
      toast.error('No pudimos guardar las notas. Probá de nuevo.');
      return;
    }
    setSaved(true);
    toast.success('Notas guardadas.');
    await onSaved();
    setTimeout(() => setSaved(false), 3000);
  }

  return (
    <div>
      <textarea
        value={notas}
        onChange={(e) => setNotas(e.target.value)}
        rows={5}
        maxLength={500}
        placeholder="Anotá información relevante sobre este miembro (preferencias, historial, lesiones, recordatorios). Solo visible para admins."
        className="ek-input"
        style={{
          marginBottom: '12px',
          resize: 'vertical',
          minHeight: '100px',
          fontFamily: 'inherit'
        }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          flexWrap: 'wrap'
        }}
      >
        <span
          style={{
            fontSize: '11px',
            color: 'var(--sala-text-tertiary)',
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {notas.length}/500 caracteres
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {saved && (
            <span style={{ color: 'var(--sala-success)', fontSize: '13px', fontWeight: 600 }}>
              ✓ Guardado
            </span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !isDirty}
            className="ek-cta"
            style={{ padding: '10px 18px', minHeight: '40px', fontSize: '13px' }}
          >
            {saving ? 'Guardando…' : 'Guardar notas'}
          </button>
        </div>
      </div>
    </div>
  );
}
