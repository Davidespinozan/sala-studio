// ============================================================================
// Enlaces "click-to-chat" de WhatsApp (wa.me) para que el staff mande mensajes al
// socio desde su propio WhatsApp (celular o WhatsApp Web). Sin API de Meta, sin
// plantillas, sin costo: abre el chat con el mensaje ya escrito y la persona da
// "Enviar". Usa el teléfono que el socio capturó en su perfil.
// ============================================================================

/**
 * Normaliza un teléfono a formato wa.me (dígitos, con lada). Asume México si vienen
 * 10 dígitos (antepone 52). Devuelve null si no parece un número usable.
 */
export function telefonoWhatsApp(telefono: string | null | undefined): string | null {
  if (!telefono) return null;
  const d = telefono.replace(/\D/g, '');
  if (d.length === 10) return '52' + d;                       // MX sin lada
  if (d.length === 13 && d.startsWith('521')) return '52' + d.slice(3); // 521… legacy → 52…
  if (d.length === 12 && d.startsWith('52')) return d;        // ya trae lada MX
  return d.length >= 10 ? d : null;                            // internacional: lo que haya
}

/**
 * Arma el link wa.me con el mensaje pre-escrito. null si el teléfono no sirve
 * (el botón debe deshabilitarse y pedir que el socio complete su teléfono).
 */
export function whatsappParaSocio(
  telefono: string | null | undefined,
  mensaje: string
): string | null {
  const num = telefonoWhatsApp(telefono);
  if (!num) return null;
  return `https://wa.me/${num}?text=${encodeURIComponent(mensaje)}`;
}
