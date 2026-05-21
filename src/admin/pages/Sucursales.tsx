import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { TIMEZONE_OPTIONS, getTenantTimezone } from '@shared/lib/timezone';
import { useSuscripcion } from '../hooks/useSuscripcion';
import { useSucursal, type Sucursal } from '../providers/SucursalProvider';
import {
  useSucursalesAdmin,
  crearSucursal,
  actualizarSucursal,
  type SucursalFormData
} from '../hooks/useSucursalesAdmin';
import Toggle from '../components/Toggle';

type ModalState = { mode: 'edit'; sucursal: Sucursal } | { mode: 'create' } | null;

function tzLabel(value: string): string {
  return TIMEZONE_OPTIONS.find((t) => t.value === value)?.label ?? value;
}

export default function Sucursales() {
  const { suscripcion, isLoading: loadingSub } = useSuscripcion();
  const { sucursales, isLoading: loadingList, refetch } = useSucursalesAdmin();
  const { refetch: refetchSelector } = useSucursal();
  const [modal, setModal] = useState<ModalState>(null);

  const esBusiness = suscripcion?.tier === 'business';

  if (loadingSub || loadingList) {
    return (
      <div className="adm-page">
        <p className="adm-body">Cargando…</p>
      </div>
    );
  }

  if (!esBusiness) {
    return <UpgradeGate cantidad={sucursales.length} />;
  }

  const activas = sucursales.filter((s) => s.activa);
  const inactivas = sucursales.filter((s) => !s.activa);

  async function handleSaved() {
    await refetch();
    await refetchSelector();
    setModal(null);
  }

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}
      >
        <div>
          <p className="ek-eyebrow">SUCURSALES</p>
          <h1 className="ek-h2">Tus sucursales</h1>
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '4px' }}>
            {activas.length} {activas.length === 1 ? 'activa' : 'activas'}
            {inactivas.length > 0 &&
              ` · ${inactivas.length} ${inactivas.length === 1 ? 'inactiva' : 'inactivas'}`}
          </p>
        </div>
        <button onClick={() => setModal({ mode: 'create' })} className="ek-cta">
          + Nueva sucursal
        </button>
      </div>

      <div
        style={{
          background: 'var(--sala-primary-light)',
          border: '1px solid var(--sala-border)',
          borderRadius: '12px',
          padding: '12px 16px'
        }}
      >
        <p style={{ fontSize: '13px', color: 'var(--sala-text-primary)', margin: 0, lineHeight: 1.5 }}>
          Cada sucursal tiene sus propias salas, instructores, horarios y zona horaria.
          Elegí con cuál estás trabajando desde el selector de arriba.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {activas.map((s) => (
          <SucursalRow key={s.id} sucursal={s} onEdit={() => setModal({ mode: 'edit', sucursal: s })} />
        ))}
      </div>

      {inactivas.length > 0 && (
        <section>
          <p
            className="ek-eyebrow"
            style={{ fontSize: '10px', color: 'var(--sala-text-tertiary)', marginBottom: '8px' }}
          >
            Inactivas
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {inactivas.map((s) => (
              <SucursalRow
                key={s.id}
                sucursal={s}
                onEdit={() => setModal({ mode: 'edit', sucursal: s })}
              />
            ))}
          </div>
        </section>
      )}

      {modal && (
        <SucursalModal
          sucursal={modal.mode === 'edit' ? modal.sucursal : null}
          sucursales={sucursales}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

// ============================================================================
// Gate de upgrade — no-Business
// ============================================================================

function UpgradeGate({ cantidad }: { cantidad: number }) {
  return (
    <div className="adm-page">
      <div
        style={{
          maxWidth: '520px',
          margin: '24px auto 0',
          textAlign: 'center',
          background: 'var(--sala-surface)',
          border: '1px solid var(--sala-border)',
          borderRadius: '16px',
          padding: '40px 28px'
        }}
      >
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>
          PLAN BUSINESS
        </p>
        <h1
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '22px',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: 'var(--sala-text-primary)',
            margin: '0 0 10px'
          }}
        >
          Manejá varias sucursales con Business
        </h1>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--sala-text-secondary)',
            margin: '0 0 22px',
            lineHeight: 1.55
          }}
        >
          Tu plan actual opera con una sola sucursal. Con Business creás sedes
          ilimitadas, cada una con sus propias salas, instructores, horarios y
          zona horaria.
        </p>
        <Link
          to="/admin/suscripcion"
          className="ek-cta"
          style={{ display: 'inline-block', textDecoration: 'none' }}
        >
          Ver plan Business
        </Link>
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: '16px 0 0' }}>
          Tu gimnasio opera hoy en {cantidad} {cantidad === 1 ? 'sucursal' : 'sucursales'}.
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Fila
// ============================================================================

function SucursalRow({ sucursal: s, onEdit }: { sucursal: Sucursal; onEdit: () => void }) {
  return (
    <div
      onClick={onEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '16px',
        background: 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderRadius: '14px',
        cursor: 'pointer',
        opacity: s.activa ? 1 : 0.6,
        transition: 'border-color 0.18s ease'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--sala-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--sala-border)';
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '16px',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: 'var(--sala-text-primary)',
            margin: '0 0 3px'
          }}
        >
          {s.nombre}
        </h3>
        <p style={{ fontSize: '12px', color: 'var(--sala-text-secondary)', margin: 0 }}>
          {s.direccion ? `${s.direccion} · ` : ''}
          {tzLabel(s.timezone)}
        </p>
      </div>
      <span
        style={{
          flexShrink: 0,
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: s.activa ? 'var(--sala-success)' : 'var(--sala-text-tertiary)'
        }}
      >
        {s.activa ? 'Activa' : 'Inactiva'}
      </span>
    </div>
  );
}

// ============================================================================
// Modal crear / editar
// ============================================================================

function SucursalModal({
  sucursal,
  sucursales,
  onClose,
  onSaved
}: {
  sucursal: Sucursal | null;
  sucursales: Sucursal[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const tenant = useTenant();
  const toast = useToast();
  const esCreacion = sucursal === null;

  const [nombre, setNombre] = useState(sucursal?.nombre ?? '');
  const [direccion, setDireccion] = useState(sucursal?.direccion ?? '');
  const [timezone, setTimezone] = useState(sucursal?.timezone ?? getTenantTimezone(tenant));
  const [activa, setActiva] = useState(sucursal?.activa ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Una sucursal siempre activa debe quedar: bloquea desactivar la última.
  const otrasActivas = sucursales.filter((s) => s.activa && s.id !== sucursal?.id).length;

  async function handleSave() {
    setError(null);
    if (!nombre.trim()) {
      setError('El nombre es obligatorio.');
      return;
    }
    if (!esCreacion && !activa && otrasActivas === 0) {
      setError('Debe quedar al menos una sucursal activa. Activá otra antes de desactivar esta.');
      return;
    }

    const data: SucursalFormData = {
      nombre: nombre.trim(),
      direccion: direccion.trim() || null,
      timezone,
      activa
    };

    setSaving(true);
    let err: string | null;
    if (esCreacion) {
      const ordenMax = sucursales.reduce((max, s) => Math.max(max, s.orden), 0);
      ({ error: err } = await crearSucursal(tenant.id, ordenMax + 1, data));
    } else {
      ({ error: err } = await actualizarSucursal(sucursal!.id, data));
    }
    setSaving(false);

    if (err) {
      setError('No pudimos guardar la sucursal. Probá de nuevo.');
      return;
    }
    toast.success(esCreacion ? 'Sucursal creada' : 'Sucursal actualizada');
    await onSaved();
  }

  return (
    <div className="adm-modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
        <p className="ek-eyebrow ek-eyebrow--mustard">
          {esCreacion ? 'NUEVA SUCURSAL' : 'EDITAR SUCURSAL'}
        </p>
        <h3 className="ek-h3" style={{ marginBottom: '1rem' }}>
          {nombre || 'Sin nombre'}
        </h3>

        <label className="ek-label">
          Nombre
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="ek-input"
            placeholder="Ej: Sucursal Centro"
          />
        </label>

        <label className="ek-label" style={{ marginTop: '14px' }}>
          Dirección (opcional)
          <input
            type="text"
            value={direccion}
            onChange={(e) => setDireccion(e.target.value)}
            className="ek-input"
            placeholder="Ej: Av. Reforma 123, CDMX"
          />
        </label>

        <label className="ek-label" style={{ marginTop: '14px' }}>
          Zona horaria
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="ek-input"
          >
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz.value} value={tz.value}>
                {tz.label}
              </option>
            ))}
          </select>
          <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>
            Las clases de esta sucursal se muestran en esta zona horaria.
          </span>
        </label>

        {!esCreacion && (
          <div className="ek-form-field" style={{ marginTop: '16px' }}>
            <Toggle
              checked={activa}
              onChange={setActiva}
              label="Sucursal activa"
              description="Si está inactiva, deja de aparecer en el selector y no se puede trabajar con ella."
            />
          </div>
        )}

        {error && <p className="ek-error-text" style={{ marginTop: '10px' }}>{error}</p>}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button
            onClick={onClose}
            disabled={saving}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            Cancelar
          </button>
          <button onClick={handleSave} disabled={saving} className="ek-cta" style={{ flex: 1 }}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}
