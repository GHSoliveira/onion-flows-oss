/**
 * IP / CIDR matching utilities.
 *
 * Comparisons are performed in a 16-byte canonical buffer so that IPv4 and
 * IPv6 (including IPv4-mapped IPv6 like ::ffff:1.2.3.4) interoperate.
 *
 * Inputs accepted:
 *   - exact IPv4: '203.0.113.42'
 *   - IPv4 CIDR:  '198.51.100.0/24'
 *   - exact IPv6: '2001:db8::1'
 *   - IPv6 CIDR:  '2001:db8::/32'
 */
import { isIP } from 'net';

export const parseEntry = (raw) => {
  const value = String(raw || '').trim();
  if (!value) return null;
  const [addr, prefixStr] = value.split('/');
  const family = isIP(addr);
  if (!family) return null;
  const totalBits = family === 4 ? 32 : 128;
  const prefix = prefixStr === undefined ? totalBits : Number.parseInt(prefixStr, 10);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > totalBits) return null;
  return { addr, family, prefix, totalBits, raw: value };
};

const ipv4ToBytes = (addr) => {
  const parts = addr.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return null;
  return Uint8Array.from(parts);
};

const ipv6ToBytes = (addr) => {
  let normalized = addr;
  const mappedMatch = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch) {
    const v4 = ipv4ToBytes(mappedMatch[2]);
    if (!v4) return null;
    const hexTail = `${v4[0].toString(16).padStart(2, '0')}${v4[1].toString(16).padStart(2, '0')}:`
      + `${v4[2].toString(16).padStart(2, '0')}${v4[3].toString(16).padStart(2, '0')}`;
    normalized = `${mappedMatch[1]}${hexTail}`;
  }
  const sides = normalized.split('::');
  if (sides.length > 2) return null;
  const expand = (segment) => (segment ? segment.split(':') : []);
  const head = expand(sides[0]);
  const tail = sides.length === 2 ? expand(sides[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const value = Number.parseInt(groups[i] || '0', 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) return null;
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
};

export const toComparableBytes = (addr) => {
  if (!addr) return null;
  const family = isIP(addr);
  if (family === 4) {
    const v4 = ipv4ToBytes(addr);
    if (!v4) return null;
    const bytes = new Uint8Array(16);
    bytes[10] = 0xff;
    bytes[11] = 0xff;
    bytes.set(v4, 12);
    return bytes;
  }
  if (family === 6) return ipv6ToBytes(addr);
  return null;
};

export const matchesEntry = (clientBytes, entry) => {
  if (!clientBytes || !entry) return false;
  const entryBytesRaw = entry.family === 4 ? ipv4ToBytes(entry.addr) : ipv6ToBytes(entry.addr);
  if (!entryBytesRaw) return false;
  const entryBytes = new Uint8Array(16);
  if (entry.family === 4) {
    entryBytes[10] = 0xff;
    entryBytes[11] = 0xff;
    entryBytes.set(entryBytesRaw, 12);
  } else {
    entryBytes.set(entryBytesRaw, 0);
  }
  const effectivePrefix = entry.family === 4 ? entry.prefix + 96 : entry.prefix;
  const fullBytes = Math.floor(effectivePrefix / 8);
  const remainderBits = effectivePrefix % 8;
  for (let i = 0; i < fullBytes; i += 1) {
    if (clientBytes[i] !== entryBytes[i]) return false;
  }
  if (remainderBits > 0) {
    const mask = (0xff << (8 - remainderBits)) & 0xff;
    if ((clientBytes[fullBytes] & mask) !== (entryBytes[fullBytes] & mask)) return false;
  }
  return true;
};

export const ipMatchesAny = (clientIp, entries) => {
  const clientBytes = toComparableBytes(clientIp);
  if (!clientBytes) return null;
  for (const entry of entries) {
    if (matchesEntry(clientBytes, entry)) return entry;
  }
  return null;
};
