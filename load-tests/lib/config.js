export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
export const USERNAME = __ENV.USERNAME || __ENV.EMAIL || '';
export const PASSWORD = __ENV.PASSWORD || '';
export const TENANT_ID = __ENV.TENANT_ID || '';
export const CHAT_ID = __ENV.CHAT_ID || '';
export const WEBHOOK_SECRET = __ENV.WEBHOOK_SECRET || '';

export const TARGET = Number(__ENV.K6_TARGET || 20);
export const RAMP_UP = __ENV.K6_RAMP_UP || '30s';
export const HOLD = __ENV.K6_HOLD || '1m';
export const RAMP_DOWN = __ENV.K6_RAMP_DOWN || '30s';

export function tenantQuery(prefix = '?') {
  return TENANT_ID ? `${prefix}tenantId=${encodeURIComponent(TENANT_ID)}` : '';
}

export function appendTenant(url) {
  if (!TENANT_ID) return url;
  return `${url}${url.includes('?') ? '&' : '?'}tenantId=${encodeURIComponent(TENANT_ID)}`;
}

export function requireCredentials() {
  if (!USERNAME || !PASSWORD) {
    throw new Error('Defina USERNAME e PASSWORD antes de rodar o teste.');
  }
}
