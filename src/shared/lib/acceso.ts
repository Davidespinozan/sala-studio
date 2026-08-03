/**
 * Contraseña temporal INICIAL, igual para todo socio nuevo. Es PÚBLICA a
 * propósito: el socio la ve, entra con su email, y la app lo OBLIGA a cambiarla
 * de inmediato (ver CambiarPasswordGate). La seguridad real del acceso físico es
 * la huella + la recepción presente; esta clave solo abre la app para reservar y
 * vive unos segundos hasta que el socio pone la suya.
 *
 * Si algún día se quiere por-gym, se mueve a `tenants.config`. Por ahora, una.
 */
export const PASSWORD_TEMPORAL_INICIAL = 'Cambiar123';