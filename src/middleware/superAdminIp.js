/**
 * Restricts admin-sensitive endpoints to a whitelist of IPs/CIDRs.
 *
 * The whitelist is composed of two sources, both consulted on every request:
 *   - DB-backed entries in `adminIpAllowlist` (managed via /api/super-admin/ip-allowlist)
 *   - Bootstrap entries from env SUPER_ADMIN_ALLOWED_IPS (immutable, never expire)
 *
 * Environment flags:
 *   SUPER_ADMIN_IP_MODE=enforce|monitor   (default: enforce in production, enforce elsewhere)
 *     - monitor: requests from un-listed IPs are allowed but logged with WARN.
 *       Use during rollout. Switch to enforce once the allowlist is populated.
 *   SUPER_ADMIN_IP_WHITELIST_DISABLED=1   (ignored in production; dev-only kill switch)
 *
 * Production safety:
 *   In NODE_ENV=production with an empty allowlist (DB + env), requests guarded
 *   by superAdminIpWhitelist fail closed. The disable flag is also ignored.
 */
import { evaluateIp, hasAnyEntry } from '../services/adminIpAllowlist.js';
import { findActiveSession } from '../services/mfaSessions.js';
import { recordAccessEvent } from '../services/adminAccessAudit.js';
import { ipMatchesAny, parseEntry } from '../utils/ipMatch.js';

const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const rawDisableFlag = String(process.env.SUPER_ADMIN_IP_WHITELIST_DISABLED || '').trim().toLowerCase();
const whitelistDisabled = !isProduction && ['1', 'true', 'yes', 'on'].includes(rawDisableFlag);

const rawMode = String(process.env.SUPER_ADMIN_IP_MODE || 'enforce').trim().toLowerCase();
const monitorMode = rawMode === 'monitor';

// req.ip is populated by Express based on the `trust proxy` setting. Do not
// parse X-Forwarded-For here — that would let an attacker spoof the source IP
// when the app is reachable without the expected proxy in front.
const CLOUDFLARE_PROXY_CIDRS = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32'
].map(parseEntry).filter(Boolean);

const headerFirstValue = (value) => {
  if (Array.isArray(value)) return value[0] || '';
  return String(value || '').split(',')[0].trim();
};

export const getClientIp = (req) => {
  const proxyIp = req.ip || null;
  const cfConnectingIp = headerFirstValue(req.headers?.['cf-connecting-ip']);
  if (proxyIp && cfConnectingIp && ipMatchesAny(proxyIp, CLOUDFLARE_PROXY_CIDRS)) {
    return cfConnectingIp;
  }
  return proxyIp;
};

const AUDIT_OUTCOMES = new Set(['denied', 'monitor_passthrough', 'allowed_mfa']);

const logAccess = (level, req, payload) => {
  const entry = {
    level,
    timestamp: new Date().toISOString(),
    clientIp: getClientIp(req) || 'unknown',
    method: req.method,
    path: req.originalUrl || req.url,
    userId: req.user?.id || null,
    role: req.user?.role || null,
    tenantId: req.user?.tenantId || null,
    ...payload
  };
  if (level === 'warn') console.warn('[SECURITY] admin-ip', entry);
  else if (level === 'info') console.log('[SECURITY] admin-ip', entry);

  // Fire-and-forget audit + socket broadcast for noteworthy outcomes only.
  if (payload?.outcome && AUDIT_OUTCOMES.has(payload.outcome)) {
    recordAccessEvent({
      outcome: payload.outcome,
      reason: payload.reason || null,
      clientIp: entry.clientIp,
      method: entry.method,
      path: entry.path,
      userId: entry.userId,
      role: entry.role,
      tenantId: entry.tenantId,
      source: payload.source || null,
      entryId: payload.entryId || null
    }).catch(() => {});
  }
};

const denyResponse = (req, res, reason, extra = {}) => {
  logAccess('warn', req, { outcome: 'denied', reason, ...extra });
  return res.status(403).json({
    error: 'Acesso negado: IP não autorizado',
    code: extra.code || 'ip_not_allowed',
    ...(extra.hint ? { hint: extra.hint } : {})
  });
};

const evaluate = async (req) => {
  const clientIp = getClientIp(req);
  const result = await evaluateIp(clientIp);
  return { clientIp, ...result };
};

// Checks whether the current request carries a fresh MFA elevation for this
// user/IP pair. Used as a second-chance bypass for SUPER_ADMIN reaching the
// API from an IP not on the persistent allowlist.
const hasMfaBypass = async (req, clientIp) => {
  if (!req.user?.id || !clientIp) return false;
  if (req.user.role !== 'SUPER_ADMIN') return false;
  const session = await findActiveSession({ userId: req.user.id, clientIp });
  return Boolean(session);
};

const handleGate = async (req, res, next, { allowOnlySuperAdminRestricted }) => {
  try {
    if (whitelistDisabled) return next();
    if (allowOnlySuperAdminRestricted && req.user?.role !== 'SUPER_ADMIN') return next();

    const populated = await hasAnyEntry();
    if (!populated) {
      if (isProduction) return denyResponse(req, res, 'empty_allowlist_production');
      return next();
    }

    const { allowed, matched, source, clientIp } = await evaluate(req);
    if (allowed) {
      if (matched?.expiresAt) {
        logAccess('info', req, { outcome: 'allowed', source, entryId: matched.id, expiresAt: matched.expiresAt });
      }
      return next();
    }

    // Second chance: SUPER_ADMIN with a fresh MFA elevation for this IP gets through.
    if (await hasMfaBypass(req, clientIp)) {
      logAccess('info', req, { outcome: 'allowed_mfa', reason: 'mfa_elevation' });
      return next();
    }

    if (monitorMode) {
      logAccess('warn', req, { outcome: 'monitor_passthrough', reason: 'ip_not_allowed' });
      return next();
    }

    if (req.user?.role === 'SUPER_ADMIN') {
      return denyResponse(req, res, 'ip_not_allowed', {
        code: 'mfa_required',
        hint: 'Solicite elevação em POST /api/auth/totp/elevate com seu código TOTP.'
      });
    }
    return denyResponse(req, res, 'ip_not_allowed');
  } catch (error) {
    logAccess('warn', req, { outcome: 'error', reason: error?.message || 'unknown' });
    return res.status(503).json({ error: 'Falha ao validar IP', code: 'ip_check_failed' });
  }
};

// Hard gate: blocks every role when IP is not on the allowlist.
// Use on routes that must be reachable only from trusted networks
// (e.g. /api/super-admin, /api/logs).
export const superAdminIpWhitelist = (req, res, next) => handleGate(req, res, next, { allowOnlySuperAdminRestricted: false });

// Soft gate: only restricts SUPER_ADMIN sessions; other roles bypass entirely.
// Use on mixed routes that handle privileged operations but are also called by
// non-super-admin staff (e.g. /api/users, /api/flows).
export const superAdminIpCheck = (req, res, next) => handleGate(req, res, next, { allowOnlySuperAdminRestricted: true });
