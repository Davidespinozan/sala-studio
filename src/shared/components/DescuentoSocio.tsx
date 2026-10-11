import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { getTenantTimezone, hoyEnTimezone, formatFechaLarga } from '@shared/lib/timezone';
import {
  descuentoDeSocio,
  listarDescuentos,
  otorgarDescuentoSocio,
  quitarDescuentoSocio,
  traducirErrorDescuento,
  venceSugerido,
  type Descuento,
  type DescuentoDeSocio
} from '@shared/lib/descuentos';

/**
 * Descuento del socio (p. ej. "Estudiante -20%") en la ficha de recepción y de
 * admin: muestra el que tiene y hasta cuándo, y deja otorgarlo, renovarlo o
 * quitarlo. Solo staff lo puede cambiar (la base lo enforce); el socio nunca.
 *
 * No pinta NADA si el gym no definió descuentos (Admin → Cobros) y el socio no
 * tiene uno: los gyms que no usan descuentos no ven ningún cambio. Por eso la
 * tarjeta/encabezado que lo rodea se pasa en `marco` (solo se pinta si hay algo).
 */
export function DescuentoSocio({
  usuarioId,
  onChanged,
  marco
}: {
  usuarioId: string;
  onChanged?: () => void | Promise<void>;
  marco?: (contenido: ReactNode) => ReactNode;
}) {
  const tenant = useTenant();
  const toast = useToast();
  const hoy = hoyEnTimezone(getTenantTimezone(tenant));

  const [catalogo, setCatalogo] = useState<Descuento[]>([]);
  const [actual, setActual] = useState<DescuentoDeSocio | null>(null);
  const [cargando, setCargando] = useState(true);
  const [editando, setEditando] = useState(false);
  const [descuentoId, setDescuentoId] = useState('');
  const [venceEl, setVenceEl] = useState('');
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    const [cat, soc] = await Promise.all([listarDescuentos(tenant.id), descuentoDeSocio(usuarioId)]);
    if (cat.error) console.error('[DescuentoSocio] catálogo:', cat.error);
    if (soc.error) console.error('[DescuentoSocio] socio:', soc.error);
    setCatalogo(cat.descuentos.filter((d) => d.activo));
    setActual(soc.descuento);
    setCargando(false);
  }, [tenant.id, usuarioId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (cargando) return null;
  if (catalogo.length === 0 && !actual) return null;

  // Vencido = pasó su fecha, o el gym desactivó ese descuento: ya no rebaja nada.
  const vigente = !!actual && actual.activo && actual.vence_el >= hoy;

  function abrirEditor() {
    const inicial = catalogo.find((d) => d.id === actual?.descuento_id) ?? catalogo[0];
    setDescuentoId(inicial?.id ?? '');
    setVenceEl(inicial ? venceSugerido(hoy, inicial.vigencia_meses) : '');
    setEditando(true);
  }

  function elegirDescuento(id: string) {
    setDescuentoId(id);
    const d = catalogo.find((x) => x.id === id);
    if (d) setVenceEl(venceSugerido(hoy, d.vigencia_meses));
  }

  async function guardar() {
    if (!descuentoId || !venceEl) return;
    setGuardando(true);
    const { error } = await otorgarDescuentoSocio(usuarioId, descuentoId, venceEl);
    setGuardando(false);
    if (error) {
      toast.error(traducirErrorDescuento(error));
      return;
    }
    toast.success('Descuento guardado.');
    setEditando(false);
    await cargar();
    await onChanged?.();
  }

  async function quitar() {
    setGuardando(true);
    const { error } = await quitarDescuentoSocio(usuarioId);
    setGuardando(false);
    if (error) {
      toast.error(traducirErrorDescuento(error));
      return;
    }
    toast.success('Descuento quitado.');
    setEditando(false);
    await cargar();
    await onChanged?.();
  }

  const contenido = (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          {actual ? (
            <>
              <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--sala-text-primary)' }}>
                {actual.nombre} · {actual.porcentaje}% de descuento
              </div>
              <div style={{ fontSize: '12.5px', color: 'var(--sala-text-secondary)', marginTop: '3px', lineHeight: 1.5 }}>
                {vigente
                  ? `Vigente hasta el ${formatFechaLarga(actual.vence_el)}. Se aplica solo al cobrar un plan (no a la inscripción).`
                  : !actual.activo
                    ? 'Este descuento está desactivado: hoy paga precio normal.'
                    : `Venció el ${formatFechaLarga(actual.vence_el)}: hoy paga precio normal. Renuévalo si sigue aplicando.`}
              </div>
            </>
          ) : (
            <div style={{ fontSize: '13px', color: 'var(--sala-text-secondary)' }}>Sin descuento. Paga precio normal.</div>
          )}
        </div>
        {!editando && catalogo.length > 0 && (
          <button type="button" className="ek-cta ek-cta--secondary" onClick={abrirEditor}>
            {actual ? (vigente ? 'Cambiar' : 'Renovar') : 'Dar descuento'}
          </button>
        )}
        {!editando && catalogo.length === 0 && actual && (
          <button type="button" className="ek-cta ek-cta--secondary" onClick={quitar} disabled={guardando}>
            Quitar
          </button>
        )}
      </div>

      {editando && (
        <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <label className="ek-label" style={{ flex: 1, minWidth: 180 }}>
              Descuento
              <select
                className="ek-input"
                value={descuentoId}
                onChange={(e) => elegirDescuento(e.target.value)}
                disabled={guardando}
              >
                {catalogo.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.nombre} · {d.porcentaje}%
                  </option>
                ))}
              </select>
            </label>
            <label className="ek-label" style={{ flex: 1, minWidth: 160 }}>
              Vence el
              <input
                className="ek-input"
                type="date"
                value={venceEl}
                min={hoy}
                onChange={(e) => setVenceEl(e.target.value)}
                disabled={guardando}
              />
            </label>
          </div>
          <p style={{ fontSize: '11.5px', color: 'var(--sala-text-tertiary)', margin: 0, lineHeight: 1.45 }}>
            Revisa la credencial antes de guardar. Al pasar la fecha el socio vuelve a precio normal
            hasta que lo renueves.
          </p>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" className="ek-cta" onClick={guardar} disabled={guardando || !descuentoId || !venceEl}>
              {guardando ? 'Guardando…' : 'Guardar'}
            </button>
            {actual && (
              <button type="button" className="ek-cta ek-cta--secondary" onClick={quitar} disabled={guardando}>
                Quitar descuento
              </button>
            )}
            <button type="button" className="ek-cta ek-cta--secondary" onClick={() => setEditando(false)} disabled={guardando}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return <>{marco ? marco(contenido) : contenido}</>;
}
