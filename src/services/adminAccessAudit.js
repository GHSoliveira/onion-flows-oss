/**
 * Audit log for admin-IP gate decisions.
 *
 * Every denial, monitor-mode pass-through, and MFA-elevated allow goes into
 * the `adminAccessAudit` collection. The same event is fanned out via
 * Socket.IO to the `role:SUPER_ADMIN` room so any super-admin who is online
 * sees it in real time (used by C4 for the alerting UX).
 *
 * Writes are best-effort: failure to persist must not break the request path.
 */
import adapter from '../../db/DatabaseAdapter.js';
import { generateId } from '../utils/helpers.js';
import { getIo } from './logs.js';

const COLLECTION = 'adminAccessAudit';
const SOCKET_EVENT = 'admin_ip_alert';

const RETENTION_DAYS = (() => {
  const raw = Number.parseInt(process.env.ADMIN_AUDIT_RETENTION_DAYS || '', 10);
  if (Number.isFinite(raw) && raw > 0 && raw <= 365) return raw;
  return 30;
})();

const ALERT_OUTCOMES = new Set(['denied', 'monitor_passthrough', 'allowed_mfa']);

const safeInsert = async (entry) => {
  try {
    if (!adapter.db) await adapter.init();
    await adapter.db.collection(COLLECTION).insertOne(entry);
  } catch (error) {
    console.warn('[ADMIN_AUDIT] Falha ao registrar evento', error?.message || error);
  }
};

const safeBroadcast = (entry) => {
  if (!ALERT_OUTCOMES.has(entry.outcome)) return;
  try {
    const io = getIo();
    if (!io) return;
    io.to('role:SUPER_ADMIN').emit(SOCKET_EVENT, entry);
  } catch (error) {
    console.warn('[ADMIN_AUDIT] Falha ao broadcastar evento', error?.message || error);
  }
};

export const recordAccessEvent = async ({
  outcome,
  reason = null,
  clientIp = null,
  method = null,
  path = null,
  userId = null,
  role = null,
  tenantId = null,
  source = null,
  entryId = null
}) => {
  const entry = {
    id: generateId('aud'),
    timestamp: new Date().toISOString(),
    outcome,
    reason,
    clientIp,
    method,
    path,
    userId,
    role,
    tenantId,
    source,
    entryId
  };
  await safeInsert(entry);
  safeBroadcast(entry);
  return entry;
};

export const listRecentAccessEvents = async ({ limit = 100, outcome = null, userId = null } = {}) => {
  if (!adapter.db) await adapter.init();
  const query = {};
  if (outcome) query.outcome = outcome;
  if (userId) query.userId = userId;
  const items = await adapter.db.collection(COLLECTION)
    .find(query, { projection: { _id: 0 } })
    .sort({ timestamp: -1 })
    .limit(Math.min(Math.max(limit, 1), 500))
    .toArray();
  return items;
};

export const purgeOldAuditEntries = async () => {
  if (!adapter.db) await adapter.init();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600_000).toISOString();
  const result = await adapter.db.collection(COLLECTION).deleteMany({ timestamp: { $lt: cutoff } });
  return result.deletedCount || 0;
};
