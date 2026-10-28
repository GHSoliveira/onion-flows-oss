import dns from 'node:dns/promises';
import { URL } from 'node:url';

// Protecao contra SSRF: requisicoes de fluxo e de integracoes nao podem
// alcancar a rede interna do servidor.
export const isPrivateIp = (rawIp) => {
  const ip = String(rawIp || '').toLowerCase();
  // IPv4 escrito como IPv6 (::ffff:10.0.0.1) cai na regra do IPv4.
  const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const parts = mapped.split('.').map(Number);
  if (parts.length === 4) {
    if (parts[0] === 10) return true;                                    // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;               // 192.168.0.0/16
    if (parts[0] === 127) return true;                                    // 127.0.0.0/8
    if (parts[0] === 169 && parts[1] === 254) return true;               // 169.254.0.0/16 (link-local/metadata)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (parts[0] === 0) return true;                                      // 0.0.0.0/8
  }
  if (ip === '::1' || ip === '::' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  return false;
};

export const validateExternalUrl = async (rawUrl) => {
  const parsed = new URL(rawUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Protocolo não permitido (somente http/https)');
  }
  const hostname = parsed.hostname;
  if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '[::]') {
    throw new Error('Requisição para host local bloqueada');
  }
  const { address } = await dns.lookup(hostname);
  if (isPrivateIp(address)) {
    throw new Error('Requisição para rede interna bloqueada');
  }
  return rawUrl;
};
