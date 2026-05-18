import { useRef, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

interface ImageUploaderProps {
  bucket: string;
  pathPrefix: string;
  currentUrl: string | null;
  onUploaded: (url: string) => void;
  onError?: (error: string) => void;
  label?: string;
  helperText?: string;
}

const MIME_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 5 * 1024 * 1024;

export default function ImageUploader({
  bucket,
  pathPrefix,
  currentUrl,
  onUploaded,
  onError,
  label = 'Imagen',
  helperText
}: ImageUploaderProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(currentUrl);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setError(null);

    if (!MIME_PERMITIDOS.includes(file.type)) {
      const msg = 'Solo se aceptan imágenes JPG, PNG o WEBP.';
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

    setIsUploading(true);

    try {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const fileName = `${pathPrefix}-${Date.now()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(fileName, file, { cacheControl: '3600', upsert: false });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(fileName);

      const publicUrl = urlData.publicUrl;
      setPreviewUrl(publicUrl);
      onUploaded(publicUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al subir imagen';
      setError(msg);
      onError?.(msg);
    } finally {
      setIsUploading(false);
    }
  };

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
        {previewUrl ? (
          <div style={{ position: 'relative' }}>
            <img
              src={previewUrl}
              alt="Preview"
              style={{
                width: '100%',
                aspectRatio: '16 / 10',
                objectFit: 'cover',
                borderRadius: 'var(--ek-r-sm)',
                background: 'var(--ek-bg-elevated)',
                display: 'block'
              }}
            />
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
                background: 'rgba(10, 10, 10, 0.85)',
                fontSize: '16px'
              }}
              aria-label="Quitar imagen"
            >
              ✕
            </button>
          </div>
        ) : (
          <div
            style={{
              aspectRatio: '16 / 10',
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
          accept="image/jpeg,image/png,image/webp"
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
    </div>
  );
}
