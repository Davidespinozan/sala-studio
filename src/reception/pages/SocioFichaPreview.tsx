// src/reception/pages/SocioFichaPreview.tsx
// ⚠️ TEMPORAL — se borra antes del commit del Sub-round 1. Solo validación visual.
// Renderiza el componente REAL <Ficha> con datos mock (no copia el markup).
import { Ficha } from './SocioFicha';
import type { SocioFichaData } from '../hooks/useSocioFicha';

const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * 86400000);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const MOCKS: { tag: string; data: SocioFichaData }[] = [
  {
    tag: '① Activa',
    data: {
      socio: { id: '1', nombre: 'Juan Méndez', email: 'juanm@gmail.com', telefono: '+52 667 123 4567', avatar_url: null, status: 'activo', bloqueado_hasta: null, notas_admin: 'Socio VIP, referido por Ale. Trato preferente.' },
      membresia: { status: 'activa', estado: 'activa', periodoFin: inDays(47), creditos: 8, tierNombre: 'Pro', tierTipo: 'hibrido' },
      estado: 'activa',
      reservas: [
        { id: 'r1', slot_inicio: at(0, 7), slot_fin: at(0, 8), recursoNombre: 'Cycling' },
        { id: 'r2', slot_inicio: at(2, 8), slot_fin: at(2, 9), recursoNombre: 'Barre' },
      ],
      asistencia: { semana: 3, mes: 11, pct: 96 },
    },
  },
  {
    tag: '② Activa · vence pronto',
    data: {
      socio: { id: '2', nombre: 'Carla Díaz', email: 'carla@gmail.com', telefono: '+52 667 555 1212', avatar_url: null, status: 'activo', bloqueado_hasta: null, notas_admin: null },
      membresia: { status: 'activa', estado: 'activa', periodoFin: inDays(3), creditos: 2, tierNombre: 'Pro', tierTipo: 'hibrido' },
      estado: 'activa',
      reservas: [{ id: 'r3', slot_inicio: at(1, 19), slot_fin: at(1, 20), recursoNombre: 'Pilates' }],
      asistencia: { semana: 2, mes: 9, pct: 90 },
    },
  },
  {
    tag: '③ Pausada',
    data: {
      socio: { id: '3', nombre: 'Ana Ruiz', email: 'anaruiz@gmail.com', telefono: '+52 667 222 8899', avatar_url: null, status: 'activo', bloqueado_hasta: null, notas_admin: 'Pausó 2 semanas por viaje. Reactivar al volver.' },
      membresia: { status: 'congelada', estado: 'pausada', periodoFin: null, creditos: 5, tierNombre: 'Pro', tierTipo: 'hibrido' },
      estado: 'pausada',
      reservas: [],
      asistencia: { semana: 0, mes: 6, pct: 88 },
    },
  },
  {
    tag: '④ Vencida',
    data: {
      socio: { id: '4', nombre: 'Luis Soto', email: 'luissoto@gmail.com', telefono: '+52 667 345 1122', avatar_url: null, status: 'activo', bloqueado_hasta: null, notas_admin: null },
      membresia: { status: 'expirada', estado: 'vencida', periodoFin: inDays(-6), creditos: 0, tierNombre: 'Básica', tierTipo: 'tiempo' },
      estado: 'vencida',
      reservas: [],
      asistencia: { semana: 0, mes: 2, pct: 71 },
    },
  },
  {
    tag: '⑤ Sin plan',
    data: {
      socio: { id: '5', nombre: 'Sofía Lara', email: 'sofialara@gmail.com', telefono: '+52 667 998 7766', avatar_url: null, status: 'pendiente_pago', bloqueado_hasta: null, notas_admin: 'Alta en mostrador. Pendiente de pago — link por WhatsApp.' },
      membresia: null,
      estado: 'sin_plan',
      reservas: [],
      asistencia: { semana: 0, mes: 0, pct: null },
    },
  },
  {
    tag: '⑥ Bloqueado (prioridad)',
    data: {
      socio: { id: '6', nombre: 'Diego Torres', email: 'diego@gmail.com', telefono: '+52 667 444 3322', avatar_url: null, status: 'activo', bloqueado_hasta: inDays(7), notas_admin: '2 no-shows seguidos.' },
      membresia: { status: 'activa', estado: 'activa', periodoFin: inDays(20), creditos: 6, tierNombre: 'Pro', tierTipo: 'hibrido' },
      estado: 'activa',
      reservas: [],
      asistencia: { semana: 1, mes: 7, pct: 80 },
    },
  },
];

export default function SocioFichaPreview() {
  return (
    <div style={{ padding: '20px' }}>
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '4px' }}>PREVIEW INTERNO · TEMPORAL</p>
      <p style={{ color: 'var(--sala-text-tertiary)', fontSize: '13px', marginBottom: '18px' }}>
        Componente real &lt;Ficha&gt; con datos mock. Se borra antes del commit del Sub-round 1.
      </p>
      <div style={{ display: 'flex', gap: '18px', overflowX: 'auto', paddingBottom: '14px', alignItems: 'flex-start' }}>
        {MOCKS.map((m) => (
          <div key={m.tag} style={{ flex: '0 0 360px', width: '360px' }}>
            <p style={{ fontFamily: 'var(--ek-font-display)', fontWeight: 700, fontSize: '13px', textTransform: 'uppercase', color: 'var(--sala-text-secondary)', marginBottom: '10px', textAlign: 'center' }}>
              {m.tag}
            </p>
            <Ficha data={m.data} />
          </div>
        ))}
      </div>
    </div>
  );
}
