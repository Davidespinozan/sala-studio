import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const MX_CENTER: [number, number] = [23.6, -102.5];

/**
 * Selector de ubicación para una sede: el admin arrastra el pin (o hace click)
 * para fijar lat/lng. Botón "Ubicar dirección" geocodifica el texto con
 * Nominatim (OpenStreetMap, gratis, sin API key). Leaflet vanilla.
 */
export default function MapaPicker({
  lat,
  lng,
  direccion,
  onChange
}: {
  lat: number | null;
  lng: number | null;
  direccion?: string;
  onChange: (lat: number, lng: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const [busy, setBusy] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const start: [number, number] = lat != null && lng != null ? [lat, lng] : MX_CENTER;
    const map = L.map(el, {
      center: start,
      zoom: lat != null ? 15 : 4,
      scrollWheelZoom: false,
      attributionControl: false
    });
    mapRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(map);

    const icon = L.divIcon({
      className: '',
      html: pinHtml(),
      iconSize: [30, 38],
      iconAnchor: [15, 36]
    });

    function place(la: number, ln: number) {
      if (markerRef.current) {
        markerRef.current.setLatLng([la, ln]);
      } else {
        const m = L.marker([la, ln], { icon, draggable: true }).addTo(map);
        m.on('dragend', () => {
          const p = m.getLatLng();
          onChange(round(p.lat), round(p.lng));
        });
        markerRef.current = m;
      }
    }

    if (lat != null && lng != null) place(lat, lng);

    map.on('click', (e: L.LeafletMouseEvent) => {
      place(e.latlng.lat, e.latlng.lng);
      onChange(round(e.latlng.lat), round(e.latlng.lng));
      setAviso(null);
    });

    const t = setTimeout(() => map.invalidateSize(), 60);

    return () => {
      clearTimeout(t);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Init una sola vez; las actualizaciones de coords vienen de este mismo picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ubicarDireccion() {
    const q = (direccion ?? '').trim();
    if (!q) {
      setAviso('Escribe la dirección arriba primero.');
      return;
    }
    setBusy(true);
    setAviso(null);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
        { headers: { 'Accept-Language': 'es' } }
      );
      const data = (await res.json()) as Array<{ lat: string; lon: string }>;
      if (!data.length) {
        setAviso('No encontramos esa dirección. Mueve el pin a mano sobre el mapa.');
        return;
      }
      const la = round(parseFloat(data[0].lat));
      const ln = round(parseFloat(data[0].lon));
      const map = mapRef.current;
      if (map) {
        map.setView([la, ln], 16);
        const icon = L.divIcon({ className: '', html: pinHtml(), iconSize: [30, 38], iconAnchor: [15, 36] });
        if (markerRef.current) markerRef.current.setLatLng([la, ln]);
        else {
          const m = L.marker([la, ln], { icon, draggable: true }).addTo(map);
          m.on('dragend', () => {
            const p = m.getLatLng();
            onChange(round(p.lat), round(p.lng));
          });
          markerRef.current = m;
        }
      }
      onChange(la, ln);
    } catch {
      setAviso('No pudimos buscar la dirección. Mueve el pin a mano sobre el mapa.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <button
          type="button"
          onClick={ubicarDireccion}
          disabled={busy}
          className="ek-cta ek-cta--secondary"
          style={{ fontSize: '13px', padding: '8px 14px' }}
        >
          {busy ? 'Buscando…' : 'Ubicar dirección en el mapa'}
        </button>
        {lat != null && lng != null && (
          <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>
            {lat.toFixed(4)}, {lng.toFixed(4)}
          </span>
        )}
      </div>
      <div
        ref={ref}
        style={{ height: '240px', width: '100%', borderRadius: 'var(--ek-r-sm)', overflow: 'hidden', border: '1px solid var(--sala-border)' }}
      />
      <span style={{ display: 'block', marginTop: '6px', fontSize: '11px', color: 'var(--ek-ink-faint)' }}>
        {aviso ?? 'Toca el mapa o arrastra el pin para fijar la ubicación exacta. Aparece como mapa en tu página pública.'}
      </span>
    </div>
  );
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function pinHtml(): string {
  return `<span style="color: var(--sala-primary); filter: drop-shadow(0 2px 3px rgba(10,15,12,0.35));">
    <svg width="30" height="38" viewBox="0 0 24 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 0C5.4 0 0 5.3 0 11.9 0 20.6 12 32 12 32s12-11.4 12-20.1C24 5.3 18.6 0 12 0z" fill="currentColor"/>
      <circle cx="12" cy="12" r="4.4" fill="#fff"/>
    </svg>
  </span>`;
}
