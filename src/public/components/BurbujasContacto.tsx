import { useLandingConfig } from '@shared/hooks/useLandingConfig';

/**
 * Burbujas flotantes de contacto (esquina inferior derecha de la web pública).
 *
 * WhatsApp e Instagram son los dos canales por los que el gym recibe gente, y
 * hasta ahora vivían enterrados en el footer: el visitante tenía que scrollear
 * hasta el final para encontrarlos. Acá quedan siempre a la vista.
 *
 * Cada burbuja aparece SOLO si el dato está cargado (Ajustes › Contacto). Si no
 * hay ninguno, no se dibuja nada.
 *
 * Color: primario/acento del tenant, no el verde de WhatsApp ni el degradado de
 * Instagram — la UI del gym solo usa su propia marca.
 */
export function BurbujasContacto() {
  const { footer, whatsappUrl } = useLandingConfig();
  const waUrl = whatsappUrl();
  const instagram = footer.redes.instagram;

  if (!waUrl && !instagram) return null;

  return (
    <div className="sala-burbujas" aria-label="Contacto rápido">
      {instagram && (
        <a
          href={instagram}
          target="_blank"
          rel="noopener noreferrer"
          className="sala-burbuja sala-burbuja--secundaria"
          aria-label="Instagram"
          title="Instagram"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="2" width="20" height="20" rx="5" />
            <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
            <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
          </svg>
        </a>
      )}

      {waUrl && (
        <a
          href={waUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="sala-burbuja sala-burbuja--principal"
          aria-label="Escríbenos por WhatsApp"
          title="Escríbenos por WhatsApp"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.25-.46-2.39-1.47-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.22 3.08c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.23 1.36.19 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.7.25-1.29.17-1.42-.07-.13-.27-.2-.57-.35z" />
            <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 18.13h-.01a8.23 8.23 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.36c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.41 5.83c0 4.54-3.7 8.24-8.24 8.24z" />
          </svg>
        </a>
      )}
    </div>
  );
}
