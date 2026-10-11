import { useCallback, useEffect, useState } from 'react';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import {
  actualizarDescuento,
  crearDescuento,
  listarDescuentos,
  traducirErrorDescuento,
  type Descuento
} from '@shared/lib/descuentos';

/**
 * Catálogo de descuentos del gym (Admin → Cobros): "Estudiante 20%, 6 meses".
 * Aquí solo se DEFINEN. A quién se le da se marca en la ficha de cada socio
 * (recepción o admin), con su fecha de vencimiento.
 */
export function DescuentosCard() {
  const tenant = useTenant();
  const toast = useToast();
  const [descuentos, setDescuentos] = useState<Descuento[]>([]);
  const [cargando, setCargando] = useState(true);
  const [noDisponible, setNoDisponible] = useState(false);
  // null = cerrado · 'nuevo' = alta · id = edición
  const [editando, setEditando] = useState<string | null>(null);
  const [nombre, setNombre] = useState('');
  const [porcentaje, setPorcentaje] = useState('');
  const [meses, setMeses] = useState('6');
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    const { descuentos: lista, error } = await listarDescuentos(tenant.id);
    if (error) {
      console.error('[DescuentosCard]', error);
      setNoDisponible(true);
    }
    setDescuentos(lista);
    setCargando(false);
  }, [tenant.id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  function abrir(d: Descuento | null) {
    setEditando(d ? d.id : 'nuevo');
    setNombre(d?.nombre ?? '');
    setPorcentaje(d ? String(d.porcentaje) : '');
    setMeses(d ? String(d.vigencia_meses) : '6');
  }

  async function guardar() {
    const pct = Number(porcentaje);
    const m = Number(meses);
    if (!nombre.trim()) return toast.error('Ponle un nombre al descuento.');
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) return toast.error('El porcentaje va de 1 a 100.');
    if (!Number.isInteger(m) || m < 1 || m > 24) return toast.error('La vigencia va de 1 a 24 meses.');

    setGuardando(true);
    const datos = { nombre: nombre.trim(), porcentaje: pct, vigencia_meses: m };
    const { error } =
      editando === 'nuevo' ? await crearDescuento(tenant.id, datos) : await actualizarDescuento(editando!, datos);
    setGuardando(false);
    if (error) return toast.error(traducirErrorDescuento(error));
    toast.success(editando === 'nuevo' ? 'Descuento creado.' : 'Descuento actualizado.');
    setEditando(null);
    await cargar();
  }

  async function toggleActivo(d: Descuento) {
    const { error } = await actualizarDescuento(d.id, { activo: !d.activo });
    if (error) return toast.error(traducirErrorDescuento(error));
    toast.success(d.activo ? 'Descuento desactivado: deja de aplicarse.' : 'Descuento activado.');
    await cargar();
  }

  if (cargando || noDisponible) return null;

  return (
    <div
      style={{
        background: 'var(--sala-surface)',
        border: '1px solid var(--sala-border)',
        borderRadius: '16px',
        padding: '20px'
      }}
    >
      <p className="ek-eyebrow" style={{ margin: '0 0 8px' }}>DESCUENTOS</p>
      <div style={{ fontSize: '12.5px', color: 'var(--sala-text-secondary)', lineHeight: 1.5, marginBottom: '12px' }}>
        Define descuentos para grupos de socios (por ejemplo, estudiantes). Se le dan a cada socio desde
        su ficha, con fecha de vencimiento, y se aplican solos al cobrarle un plan en recepción o en la
        app. No rebajan la inscripción ni los pases de un día.
      </div>

      {descuentos.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
          {descuentos.map((d) => (
            <div
              key={d.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                flexWrap: 'wrap',
                padding: '12px 14px',
                border: '1px solid var(--sala-border)',
                borderRadius: '12px',
                opacity: d.activo ? 1 : 0.6
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--sala-text-primary)' }}>
                  {d.nombre} · {d.porcentaje}%
                </div>
                <div style={{ fontSize: '12px', color: 'var(--sala-text-secondary)', marginTop: '2px' }}>
                  Vigencia sugerida: {d.vigencia_meses} {d.vigencia_meses === 1 ? 'mes' : 'meses'}
                  {!d.activo && ' · desactivado'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" className="ek-cta ek-cta--secondary" onClick={() => abrir(d)}>
                  Editar
                </button>
                <button type="button" className="ek-cta ek-cta--secondary" onClick={() => void toggleActivo(d)}>
                  {d.activo ? 'Desactivar' : 'Activar'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editando ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <label className="ek-label" style={{ flex: 2, minWidth: 180 }}>
              Nombre
              <input
                className="ek-input"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Estudiante"
                maxLength={40}
                disabled={guardando}
              />
            </label>
            <label className="ek-label" style={{ flex: 1, minWidth: 110 }}>
              Porcentaje
              <input
                className="ek-input"
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                value={porcentaje}
                onChange={(e) => setPorcentaje(e.target.value)}
                placeholder="20"
                disabled={guardando}
              />
            </label>
            <label className="ek-label" style={{ flex: 1, minWidth: 110 }}>
              Vigencia (meses)
              <input
                className="ek-input"
                type="number"
                inputMode="numeric"
                min={1}
                max={24}
                value={meses}
                onChange={(e) => setMeses(e.target.value)}
                disabled={guardando}
              />
            </label>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="ek-cta" onClick={() => void guardar()} disabled={guardando}>
              {guardando ? 'Guardando…' : 'Guardar'}
            </button>
            <button type="button" className="ek-cta ek-cta--secondary" onClick={() => setEditando(null)} disabled={guardando}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="ek-cta ek-cta--secondary" onClick={() => abrir(null)}>
          + Nuevo descuento
        </button>
      )}
    </div>
  );
}
