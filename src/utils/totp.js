/**
 * Minimal TOTP (RFC 6238) implementation built on top of Node's crypto module.
 * Used to enforce a second factor on SUPER_ADMIN sessions reaching the API from
 * IPs that are not on the persistent allowlist.
 *
 * - Secret is stored base32-encoded so the value can be displayed to humans
 *   and consumed by standard authenticator apps (Google Authenticator, Authy, …).
 * - Codes are 6 digits, 30-second windows. Verification accepts a ±1 step
 *   skew to tolerate clock drift.
 */
import crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
const SKEW_STEPS = 1;

const toUint8 = (value) => {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Uint8Array.from(value);
};

export const base32Encode = (input) => {
  const bytes = toUint8(input);
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < bytes.length; i += 1) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
};

export const base32Decode = (input) => {
  const cleaned = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (!cleaned) return null;
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const ch of cleaned) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
};

export const generateSecret = (lengthBytes = 20) => base32Encode(crypto.randomBytes(lengthBytes));

const counterBuffer = (counter) => {
  const buf = Buffer.alloc(8);
  let value = BigInt(counter);
  for (let i = 7; i >= 0; i -= 1) {
    buf[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return buf;
};

export const generateCode = (secret, { time = Date.now(), step = STEP_SECONDS, digits = DIGITS } = {}) => {
  const key = base32Decode(secret);
  if (!key) return null;
  const counter = Math.floor(time / 1000 / step);
  const hmac = crypto.createHmac('sha1', Buffer.from(key)).update(counterBuffer(counter)).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  const code = String(binary % 10 ** digits).padStart(digits, '0');
  return code;
};

const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
};

export const verifyCode = (secret, presented, { time = Date.now(), step = STEP_SECONDS, digits = DIGITS, skew = SKEW_STEPS } = {}) => {
  const code = String(presented || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  for (let offset = -skew; offset <= skew; offset += 1) {
    const expected = generateCode(secret, { time: time + offset * step * 1000, step, digits });
    if (expected && safeEqual(expected, code)) return true;
  }
  return false;
};

export const otpauthUrl = ({ secret, label, issuer = 'Onion Web Flows' }) => {
  const encodedLabel = encodeURIComponent(`${issuer}:${label}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS)
  });
  return `otpauth://totp/${encodedLabel}?${params.toString()}`;
};
