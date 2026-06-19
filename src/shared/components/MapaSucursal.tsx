import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * Mapa read-only de una sede (Leaflet + OpenStreetMap, sin API key).
 * Se usa en la landing (popout de sede + sección "Dónde estamos" de 1 sola sede).
 * El pin toma el color de marca del tenant (--sala-primary).
 */
export default function MapaSucursal({
  lat,
  lng,
  nombre,
  direccion,
  height = 220
}: {
  lat: number;
  lng: number;
  nombre?: string;
  direccion?: string | null;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const map = L.map(el, {
      center: [lat, lng],
      zoom: 15,
      scrollWheelZoom: false,
      zoomControl: true,
      attributionControl: false
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(map);

    const icon = L.divIcon({
      className: '',
      html: pinHtml(),
      iconSize: [30, 38],
      iconAnchor: [15, 36],
      popupAnchor: [0, -34]
    });
    const marker = L.marker([lat, lng], { icon }).addTo(map);
    if (nombre) marker.bindPopup(`<strong>${escapeHtml(nombre)}</strong>`);

    // Recalcula tamaño tras montar (contenedores con clamp/flex a veces miden 0).
    const t = setTimeout(() => map.invalidateSize(), 60);

    return () => {
      clearTimeout(t);
      map.remove();
    };
  }, [lat, lng, nombre]);

  return (
    <div>
      <div
        ref={ref}
        style={{
          height: `${height}px`,
          width: '100%',
          borderRadius: 'var(--ek-r-sm)',
          overflow: 'hidden',
          border: '1px solid var(--sala-border)'
        }}
      />
      <a
        href={`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          marginTop: '10px',
          fontSize: '13px',
          fontWeight: 600,
          color: 'var(--sala-primary)',
          textDecoration: 'none'
        }}
      >
        Cómo llegar →
      </a>
      {direccion && (
        <span style={{ display: 'block', marginTop: '4px', fontSize: '12px', color: 'var(--sala-text-tertiary)' }}>
          {direccion}
        </span>
      )}
    </div>
  );
}

function pinHtml(): string {
  return `<span style="color: var(--sala-primary); filter: drop-shadow(0 2px 3px rgba(10,15,12,0.35));">
    <svg width="30" height="38" viewBox="0 0 24 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 0C5.4 0 0 5.3 0 11.9 0 20.6 12 32 12 32s12-11.4 12-20.1C24 5.3 18.6 0 12 0z" fill="currentColor"/>
      <circle cx="12" cy="12" r="4.4" fill="#fff"/>
    </svg>
  </span>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
  );
}
