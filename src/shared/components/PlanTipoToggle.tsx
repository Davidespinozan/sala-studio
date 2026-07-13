export type VistaPlan = 'membresias' | 'paquetes';

interface Props {
  value: VistaPlan;
  onChange: (v: VistaPlan) => void;
}

/**
 * Pestañas Membresías · Paquetes para la sección de planes.
 *
 * Los dos modelos conviven (mensualidad/quincena de acceso vs paquete de clases),
 * y mostrarlos juntos amontonaba una pared de tarjetas donde el socio no entendía
 * qué estaba comparando. Con el toggle nunca se ven los dos grupos a la vez.
 */
export function PlanTipoToggle({ value, onChange }: Props) {
  return (
    <div className="sala-plan-toggle" role="tablist" aria-label="Tipo de plan">
      <button
        type="button"
        role="tab"
        aria-selected={value === 'membresias'}
        className={`sala-plan-toggle-btn ${value === 'membresias' ? 'is-active' : ''}`}
        onClick={() => onChange('membresias')}
      >
        Membresías
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'paquetes'}
        className={`sala-plan-toggle-btn ${value === 'paquetes' ? 'is-active' : ''}`}
        onClick={() => onChange('paquetes')}
      >
        Paquetes de clases
      </button>
    </div>
  );
}
