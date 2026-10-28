/**
 * Field-level encryption with AES-256-GCM and a keyring for rotation.
 *
 * Designed for storing credentials at-rest (channel tokens, webhook verify
 * tokens, secretNode values). The format is self-describing so a token can
 * be decrypted years later as long as the corresponding key is still in the
 * keyring.
 *
 * Configuration (env):
 *   DATA_ENCRYPTION_KEYS=v1:<base64-32B>,v2:<base64-32B>
 *     Comma-separated list of keyId:base64 pairs. Each key must decode to
 *     exactly 32 bytes (AES-256). Old keys stay in the keyring so legacy
 *     ciphertexts remain readable after rotation.
 *   ACTIVE_DATA_KEY=v2
 *     Which keyId to use for *new* encryptions. Defaults to the last entry
 *     in DATA_ENCRYPTION_KEYS.
 *
 * Output format:
 *   enc:v1:<keyId>:<iv-b64>:<tag-b64>:<ciphertext-b64>
 *
 * The "enc:v1:" prefix is the version of the wrapping format itself, not the
 * crypto algorithm — it lets us evolve the wire layout (e.g. switch to
 * AES-256-SIV) without breaking older blobs. The keyId is the rotation
 * version of the *key material*.
 *
 * Helpers exported:
 *   encryptString(plaintext)  → string  (no-op if no keyring configured)
 *   decryptString(token)      → string  (no-op for unencrypted strings)
 *   isEncrypted(value)        → boolean
 *   encryptionAvailable()     → boolean
 *
 * All functions are synchronous (crypto module is native). Errors during
 * decryption throw to surface integrity failures — never silently fall back
 * to the (possibly bogus) ciphertext.
 */
import crypto from 'crypto';

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard

const parseKeyring = () => {
  const raw = String(process.env.DATA_ENCRYPTION_KEYS || '').trim();
  if (!raw) return new Map();
  const map = new Map();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 1) continue;
    const id = trimmed.slice(0, colon).trim();
    const b64 = trimmed.slice(colon + 1).trim();
    if (!id || !b64) continue;
    try {
      const buf = Buffer.from(b64, 'base64');
      if (buf.length !== 32) {
        console.warn(`[CRYPTO] Chave ${id} ignorada: deve ter 32 bytes (256 bits). Tem ${buf.length}.`);
        continue;
      }
      map.set(id, buf);
    } catch (error) {
      console.warn(`[CRYPTO] Falha ao decodificar chave ${id}:`, error?.message || error);
    }
  }
  return map;
};

const keyring = parseKeyring();

const activeKeyId = (() => {
  const declared = String(process.env.ACTIVE_DATA_KEY || '').trim();
  if (declared && keyring.has(declared)) return declared;
  if (keyring.size === 0) return null;
  // Fallback: pick the last entry (parse order preserves insertion).
  return Array.from(keyring.keys()).pop();
})();

if (keyring.size === 0) {
  console.warn('[CRYPTO] DATA_ENCRYPTION_KEYS vazio — criptografia at-rest desligada. Credenciais ficarão em texto claro.');
}

export const encryptionAvailable = () => Boolean(activeKeyId);

export const isEncrypted = (value) => typeof value === 'string' && value.startsWith(PREFIX);

export const encryptString = (plaintext) => {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  if (typeof plaintext !== 'string') return plaintext;
  if (isEncrypted(plaintext)) return plaintext;
  if (!activeKeyId) return plaintext;

  const key = keyring.get(activeKeyId);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${activeKeyId}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
};

export const decryptString = (value) => {
  if (typeof value !== 'string' || !isEncrypted(value)) return value;
  const body = value.slice(PREFIX.length);
  const [keyId, ivB64, tagB64, ctB64] = body.split(':');
  if (!keyId || !ivB64 || !tagB64 || !ctB64) {
    throw new Error('Ciphertext malformado');
  }
  const key = keyring.get(keyId);
  if (!key) {
    throw new Error(`Chave ${keyId} não encontrada no keyring`);
  }
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString('utf8');
};

// Convenience helper: returns the plaintext if the value is encrypted,
// otherwise returns it unchanged. Useful when reading legacy records that may
// or may not have been encrypted.
export const tryDecrypt = (value) => {
  if (!isEncrypted(value)) return value;
  try {
    return decryptString(value);
  } catch (error) {
    console.warn('[CRYPTO] Falha ao decifrar valor — retornando como veio:', error.message);
    return value;
  }
};
