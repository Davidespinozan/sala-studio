import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { requireEnv } from './env';

/**
 * Cifrado de las plantillas de huella.
 *
 * La llave vive ACÁ (variable de entorno de Netlify), no en Supabase. Esa
 * separación es todo el punto: un volcado de la base —un backup filtrado, un
 * token de service_role robado, una consulta mal hecha— se lleva ruido. Para
 * leer una huella hay que tener las dos cosas.
 *
 * AES-256-GCM: además de cifrar, autentica. Si alguien edita el blob en la base
 * para intentar colar una plantilla ajena, el descifrado falla en vez de
 * devolver basura que el lector podría llegar a matchear.
 *
 * Formato del blob:  [ iv (12) | tag (16) | ciphertext ]
 */

const IV_LEN = 12;
const TAG_LEN = 16;

function llave(): Buffer {
  // 32 bytes en base64. Se genera una vez:  openssl rand -base64 32
  const key = Buffer.from(requireEnv('HUELLA_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) {
    throw new Error('HUELLA_ENCRYPTION_KEY debe ser 32 bytes en base64 (openssl rand -base64 32)');
  }
  return key;
}

/** Plantilla en claro (base64, como la manda el agente) → blob cifrado (base64). */
export function cifrarPlantilla(plantillaB64: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', llave(), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plantillaB64, 'base64')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Blob cifrado (base64, como sale de la base) → plantilla en claro (base64). */
export function descifrarPlantilla(blobB64: string): string {
  const blob = Buffer.from(blobB64, 'base64');
  if (blob.length <= IV_LEN + TAG_LEN) {
    throw new Error('Blob de huella corrupto');
  }
  const decipher = createDecipheriv('aes-256-gcm', llave(), blob.subarray(0, IV_LEN));
  decipher.setAuthTag(blob.subarray(IV_LEN, IV_LEN + TAG_LEN));
  const plano = Buffer.concat([
    decipher.update(blob.subarray(IV_LEN + TAG_LEN)),
    decipher.final()
  ]);
  return plano.toString('base64');
}
