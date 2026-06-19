import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Cropper, { type Area } from 'react-easy-crop';
import { X } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';

interface ImageUploaderProps {
  bucket: string;
  pathPrefix: string;
  currentUrl: string | null;
  onUploaded: (url: string) => void;
  onError?: (error: string) => void;
  label?: string;
  helperText?: string;
  /**
   * Permite subir SVG además de raster. Pensado para logos/isotipos: un SVG
   * es vectorial y se ve nítido en cualquier densidad de pantalla (retina),
   * a diferencia de un PNG chico que se pixela al escalar. Off por defecto
   * (las fotos de clase/instructor siguen siendo solo raster).
   */
  allowSvg?: boolean;
  /**
   * Imagen a mostrar en el preview cuando NO hay una subida propia (currentUrl
   * null). Sirve para mostrar el placeholder real — ej. el logo de SALA que se
   * ve hoy en la app — y dejar claro que al subir uno se reemplaza. No se trata
   * como valor guardado: no aparece el botón de quitar.
   */
  fallbackPreviewUrl?: string;
  /** object-fit del preview. 'contain' para logos (se ve completo), 'cover' para fotos. Default 'cover'. */
  previewFit?: 'cover' | 'contain';
  /**
   * Si se pasa, al elegir una imagen se abre un recorte (zoom + arrastrar) al
   * aspect ratio dado (ancho/alto), y se sube ya recortada. Ej: salas 16/10,
   * instructores 3/4. Sin esto, la imagen se sube tal cual. No aplica a SVG.
   */
  cropAspect?: number;
  /**
   * Alto máximo (px) del preview. Evita que un preview vertical (ej. 3:4) se
   * estire a lo alto y quede desproporcionado en el formulario. Default 300.
   */
  previewMaxHeight?: number;
}

const MIME_RASTER = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 5 * 1024 * 1024;
/** Lado máximo del recorte exportado — evita subir imágenes enormes. */
const CROP_MAX_DIM = 1600;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener('load', () => resolve(img));
    img.addEventListener('error', () => reject(new Error('No se pudo leer la imagen.')));
    img.src = src;
  });
}

/** Recorta el área seleccionada a un canvas y devuelve un Blob (jpeg/png). */
async function getCroppedBlob(src: string, area: Area, mime: string): Promise<Blob> {
  const image = await loadImage(src);
  let scale = 1;
  const lado = Math.max(area.width, area.height);
  if (lado > CROP_MAX_DIM) scale = CROP_MAX_DIM / lado;
  const outW = Math.max(1, Math.round(area.width * scale));
  const outH = Math.max(1, Math.round(area.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No se pudo procesar la imagen.');
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, outW, outH);

  const outMime = mime === 'image/png' ? 'image/png' : 'image/jpeg';
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo generar la imagen.'))), outMime, 0.9);
  });
}

export default function ImageUploader({
  bucket,
  pathPrefix,
  currentUrl,
  onUploaded,
  onError,
  label = 'Imagen',
  helperText,
  allowSvg = false,
  fallbackPreviewUrl,
  previewFit = 'cover',
  cropAspect,
  previewMaxHeight = 300
}: ImageUploaderProps) {
  const mimePermitidos = allowSvg ? [...MIME_RASTER, 'image/svg+xml'] : MIME_RASTER;
  const [isUploading, setIsUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(currentUrl);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Estado del recorte
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [cropMime, setCropMime] = useState<string>('image/jpeg');
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [areaPixels, setAreaPixels] = useState<Area | null>(null);

  // currentUrl llega async (el draft de marca se carga después del mount). Sin
  // esto el preview se quedaba pegado en el fallback "Por defecto" aunque ya
  // hubiera un logo subido.
  useEffect(() => {
    setPreviewUrl(currentUrl);
  }, [currentUrl]);

  const shownUrl = previewUrl ?? fallbackPreviewUrl ?? null;
  const esFallback = !previewUrl && !!fallbackPreviewUrl;
  const previewAspect = cropAspect ?? 16 / 10;
  // Ancho máximo derivado del alto tope: así un preview vertical no se estira.
  const previewMaxWidth = Math.round(previewMaxHeight * previewAspect);

  async function uploadBlob(data: Blob, ext: string) {
    setIsUploading(true);
    try {
      const fileName = `${pathPrefix}-${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(fileName, data, { cacheControl: '3600', upsert: false, contentType: data.type });
      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(fileName);
      setPreviewUrl(urlData.publicUrl);
      onUploaded(urlData.publicUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'No pudimos subir la imagen. Prueba con otra.';
      setError(msg);
      onError?.(msg);
    } finally {
      setIsUploading(false);
    }
  }

  const handleFile = (file: File) => {
    setError(null);

    if (!mimePermitidos.includes(file.type)) {
      const msg = allowSvg
        ? 'Solo se aceptan imágenes JPG, PNG, WEBP o SVG.'
        : 'Solo se aceptan imágenes JPG, PNG o WEBP.';
      setError(msg);
      onError?.(msg);
      return;
    }
    if (file.size > MAX_BYTES) {
      const msg = 'La imagen no puede pesar más de 5MB.';
      setError(msg);
      onError?.(msg);
      return;
    }

    const ext = file.name.split('.').pop()?.toLowerCase() || (file.type === 'image/png' ? 'png' : 'jpg');

    // Con cropAspect (y no SVG) → abrir recorte. Si no, subir tal cual.
    if (cropAspect && file.type !== 'image/svg+xml') {
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setAreaPixels(null);
      setCropMime(file.type);
      setCropSrc(URL.createObjectURL(file));
    } else {
      void uploadBlob(file, ext);
    }
  };

  function closeCropper() {
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function confirmCrop() {
    if (!cropSrc || !areaPixels) return;
    try {
      const blob = await getCroppedBlob(cropSrc, areaPixels, cropMime);
      const ext = blob.type === 'image/png' ? 'png' : 'jpg';
      closeCropper();
      await uploadBlob(blob, ext);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'No pudimos recortar la imagen.';
      setError(msg);
      onError?.(msg);
      closeCropper();
    }
  }

  const handleClick = () => inputRef.current?.click();

  const handleClear = () => {
    setPreviewUrl(null);
    onUploaded('');
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="ek-form-field">
      {label && <label className="ek-label">{label}</label>}

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          padding: '16px',
          background: 'var(--ek-bg-soft)',
          border: '0.5px dashed var(--ek-line)',
          borderRadius: 'var(--ek-r-md)'
        }}
      >
        {shownUrl ? (
          <div style={{ position: 'relative', width: '100%', maxWidth: `${previewMaxWidth}px`, margin: '0 auto' }}>
            <img
              src={shownUrl}
              alt="Preview"
              style={{
                width: '100%',
                aspectRatio: previewAspect,
                objectFit: previewFit,
                borderRadius: 'var(--ek-r-sm)',
                background: 'var(--ek-bg-elevated)',
                display: 'block',
                padding: previewFit === 'contain' ? '16px' : 0
              }}
            />
            {esFallback ? (
              <span
                style={{
                  position: 'absolute',
                  top: '8px',
                  left: '8px',
                  padding: '4px 10px',
                  borderRadius: '999px',
                  background: 'rgba(26, 31, 28, 0.7)',
                  color: '#fff',
                  fontSize: '10px',
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase'
                }}
              >
                Por defecto
              </span>
            ) : (
              <button
                type="button"
                onClick={handleClear}
                className="ek-icon-btn"
                style={{
                  position: 'absolute',
                  top: '8px',
                  right: '8px',
                  width: '32px',
                  height: '32px',
                  padding: 0,
                  background: 'rgba(26, 31, 28, 0.85)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
                aria-label="Quitar imagen"
              >
                <X size={16} strokeWidth={2.25} />
              </button>
            )}
          </div>
        ) : (
          <div
            style={{
              aspectRatio: previewAspect,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--ek-bg-elevated)',
              borderRadius: 'var(--ek-r-sm)',
              gap: '8px'
            }}
          >
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--ek-ink-faint)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <span
              style={{
                fontSize: '11px',
                color: 'var(--ek-ink-faint)',
                letterSpacing: '0.1em',
                fontWeight: 600,
                textTransform: 'uppercase'
              }}
            >
              Sin imagen
            </span>
          </div>
        )}

        <button
          type="button"
          onClick={handleClick}
          disabled={isUploading}
          className="ek-cta"
          style={{ padding: '10px 14px', fontSize: '13px' }}
        >
          {isUploading ? 'Subiendo...' : previewUrl ? 'Cambiar imagen' : 'Subir imagen'}
        </button>

        <input
          ref={inputRef}
          type="file"
          accept={mimePermitidos.join(',')}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
          style={{ display: 'none' }}
        />

        {error && <p style={{ fontSize: '12px', color: 'var(--ek-danger)', margin: 0 }}>{error}</p>}

        {helperText && !error && (
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', margin: 0 }}>
            {helperText}
          </p>
        )}
      </div>

      {/* Modal de recorte */}
      {cropSrc &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 200,
              background: 'rgba(10, 15, 12, 0.7)',
              backdropFilter: 'blur(4px)',
              WebkitBackdropFilter: 'blur(4px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 'max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))'
            }}
            onClick={closeCropper}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '100%',
                maxWidth: '440px',
                background: 'var(--sala-surface)',
                borderRadius: 'var(--ek-r-card)',
                padding: '18px',
                boxShadow: 'var(--ek-shadow-modal)'
              }}
            >
              <p
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--sala-primary)',
                  margin: '0 0 12px'
                }}
              >
                Ajusta el encuadre
              </p>

              <div
                style={{
                  position: 'relative',
                  width: '100%',
                  height: '300px',
                  background: 'var(--sala-neutral-dark)',
                  borderRadius: 'var(--ek-r-sm)',
                  overflow: 'hidden'
                }}
              >
                <Cropper
                  image={cropSrc}
                  crop={crop}
                  zoom={zoom}
                  aspect={cropAspect ?? 16 / 10}
                  onCropChange={setCrop}
                  onZoomChange={setZoom}
                  onCropComplete={(_area, areaPx) => setAreaPixels(areaPx)}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '14px 0 4px' }}>
                <span style={{ fontSize: '11px', color: 'var(--sala-text-tertiary)', fontWeight: 600 }}>Zoom</span>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.01}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  style={{ flex: 1, accentColor: 'var(--sala-primary)' }}
                  aria-label="Zoom"
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
                <button
                  type="button"
                  onClick={closeCropper}
                  className="ek-cta ek-cta--secondary"
                  style={{ flex: 1 }}
                >
                  Cancelar
                </button>
                <button type="button" onClick={confirmCrop} className="ek-cta ek-lift" style={{ flex: 1 }}>
                  Recortar y subir
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
