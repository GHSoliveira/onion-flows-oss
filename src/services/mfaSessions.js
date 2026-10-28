/**
 * MFA elevation sessions.
 *
 * When a SUPER_ADMIN reaches the API from an IP that is not on the allowlist,
 * the gate refuses the request unless a fresh MFA session exists for that
 * (userId, clientIp) pair. Sessions are created via /api/auth/totp/elevate
 * after the user presents a valid TOTP code plus password.
 *
 * Sessions are short-lived (default: 30 minutes) and bound to the IP that
 * presented the second factor — replaying the session from a different network
 * does not work.
 */
import crypto from 'crypto';
import adapter from '../../db/DatabaseAdapter.js';

const COLLECTION = 'mfaSessions';
const DEFAULT_TTL_MINUTES = 30;

const ttlMinutes = (() => {
  const raw = Number.parseInt(process.env.MFA_SESSION_TTL_MINUTES || '', 10);
  if (Number.isFinite(raw) && raw > 0 && raw <= 8 * 60) return raw;
  return DEFAULT_TTL_MINUTES;
})();

const nowIso = () => new Date().toISOString();

export const purgeExpiredSessions = async () => {
  if (!adapter.db) await adapter.init();
  const collection = adapter.db.collection(COLLECTION);
  const result = await collection.deleteMany({ expiresAt: { $lte: nowIso() } });
  return result.deletedCount || 0;
};

export const createSession = async ({ userId, clientIp }) => {
  if (!userId || !clientIp) {
    const err = new Error('userId e clientIp são obrigatórios');
    err.statusCode = 400;
    throw err;
  }
  if (!adapter.db) await adapter.init();
  await purgeExpiredSessions();
  const collection = adapter.db.collection(COLLECTION);
  const id = `mfa_${crypto.randomBytes(16).toString('hex')}`;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  const session = {
    id,
    userId,
    ip: clientIp,
    createdAt: nowIso(),
    expiresAt
  };
  await collection.insertOne(session);
  return { id, userId, ip: clientIp, expiresAt, ttlMinutes };
};

export const findActiveSession = async ({ userId, clientIp }) => {
  if (!userId || !clientIp) return null;
  if (!adapter.db) await adapter.init();
  const collection = adapter.db.collection(COLLECTION);
  const session = await collection.findOne(
    { userId, ip: clientIp, expiresAt: { $gt: nowIso() } },
    { projection: { _id: 0 } }
  );
  return session || null;
};

export const revokeSessionsForUser = async (userId) => {
  if (!userId) return 0;
  if (!adapter.db) await adapter.init();
  const collection = adapter.db.collection(COLLECTION);
  const result = await collection.deleteMany({ userId });
  return result.deletedCount || 0;
};

export const getSessionTtlMinutes = () => ttlMinutes;
