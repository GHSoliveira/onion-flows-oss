/**
 * Admin IP allowlist — persisted in MongoDB (collection: adminIpAllowlist) and
 * merged at runtime with bootstrap entries from the SUPER_ADMIN_ALLOWED_IPS env
 * variable.
 *
 * Bootstrap entries (env) are always evaluated, never expire, cannot be
 * mutated through the API, and tagged with source='bootstrap'. They exist to
 * resolve the chicken-and-egg problem: if the DB list is empty or a misedit
 * locks every admin out, the operator can still reach the system from any IP
 * listed in the env.
 *
 * Cache: in-process 30s window. Mutations call invalidateAllowlistCache().
 */
import adapter from '../../db/DatabaseAdapter.js';
import { parseEntry, ipMatchesAny } from '../utils/ipMatch.js';
import { generateId } from '../utils/helpers.js';

const CACHE_TTL_MS = 30_000;
const COLLECTION = 'adminIpAllowlist';

let cache = null;
let cacheLoadedAt = 0;
let inflight = null;

const nowIso = () => new Date().toISOString();

const isExpired = (entry, nowMs) => {
  if (!entry?.expiresAt) return false;
  const ts = new Date(entry.expiresAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return ts <= nowMs;
};

const loadBootstrapEntries = () => {
  const raw = String(process.env.SUPER_ADMIN_ALLOWED_IPS || '');
  return raw
    .split(',')
    .map((value) => {
      const parsed = parseEntry(value);
      if (!parsed) return null;
      return {
        id: `bootstrap:${parsed.raw}`,
        ip: parsed.raw,
        label: 'env bootstrap',
        source: 'bootstrap',
        expiresAt: null,
        createdBy: 'env',
        createdAt: '1970-01-01T00:00:00.000Z',
        updatedAt: '1970-01-01T00:00:00.000Z',
        __parsed: parsed
      };
    })
    .filter(Boolean);
};

const loadDbEntries = async () => {
  if (!adapter.db) await adapter.init();
  const collection = adapter.db.collection(COLLECTION);
  const rows = await collection.find({}, { projection: { _id: 0 } }).toArray();
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    __parsed: parseEntry(row.ip)
  })).filter((row) => row.__parsed);
};

const ensureFresh = async () => {
  const elapsed = Date.now() - cacheLoadedAt;
  if (cache && elapsed < CACHE_TTL_MS) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const [bootstrap, dbRows] = await Promise.all([
        Promise.resolve(loadBootstrapEntries()),
        loadDbEntries()
      ]);
      cache = { bootstrap, dbRows, loadedAt: Date.now() };
      cacheLoadedAt = Date.now();
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
};

export const invalidateAllowlistCache = () => {
  cache = null;
  cacheLoadedAt = 0;
};

const visibleEntries = (snapshot, nowMs) => {
  const live = snapshot.dbRows.filter((entry) => !isExpired(entry, nowMs));
  return [...snapshot.bootstrap, ...live];
};

/**
 * Evaluate a client IP against the current allowlist.
 * Returns { allowed, matched, source }. `matched` is the entry that authorised
 * the request (or null when denied). `source` mirrors `matched.source` for
 * logging convenience.
 */
export const evaluateIp = async (clientIp) => {
  const snapshot = await ensureFresh();
  const visible = visibleEntries(snapshot, Date.now());
  const matchedParsed = ipMatchesAny(clientIp, visible.map((entry) => entry.__parsed));
  if (!matchedParsed) return { allowed: false, matched: null, source: null };
  const matched = visible.find((entry) => entry.__parsed === matchedParsed) || null;
  return {
    allowed: true,
    matched: matched ? sanitizeEntry(matched) : null,
    source: matched?.source || 'manual'
  };
};

export const hasAnyEntry = async () => {
  const snapshot = await ensureFresh();
  const visible = visibleEntries(snapshot, Date.now());
  return visible.length > 0;
};

const sanitizeEntry = (entry) => ({
  id: entry.id,
  ip: entry.ip,
  label: entry.label || '',
  source: entry.source || 'manual',
  expiresAt: entry.expiresAt || null,
  createdBy: entry.createdBy || null,
  createdAt: entry.createdAt || null,
  updatedAt: entry.updatedAt || null
});

export const listEntries = async () => {
  const snapshot = await ensureFresh();
  const visible = visibleEntries(snapshot, Date.now());
  return visible.map(sanitizeEntry);
};

const persistEntry = async (entry) => {
  if (!adapter.db) await adapter.init();
  const collection = adapter.db.collection(COLLECTION);
  await collection.updateOne({ id: entry.id }, { $set: entry }, { upsert: true });
  invalidateAllowlistCache();
};

export const createEntry = async ({ ip, label, expiresAt, createdBy, source = 'manual' }) => {
  const parsed = parseEntry(ip);
  if (!parsed) {
    const err = new Error('IP ou CIDR inválido');
    err.statusCode = 400;
    throw err;
  }
  const safeLabel = String(label || '').trim().slice(0, 200);
  const safeExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;
  if (safeExpiresAt && !Number.isFinite(new Date(safeExpiresAt).getTime())) {
    const err = new Error('expiresAt inválido');
    err.statusCode = 400;
    throw err;
  }
  const entry = {
    id: generateId('aip'),
    ip: parsed.raw,
    label: safeLabel,
    source,
    expiresAt: safeExpiresAt,
    createdBy: createdBy || null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  await persistEntry(entry);
  return sanitizeEntry(entry);
};

export const updateEntry = async (id, { label, expiresAt }) => {
  if (!adapter.db) await adapter.init();
  const collection = adapter.db.collection(COLLECTION);
  const update = { updatedAt: nowIso() };
  if (label !== undefined) update.label = String(label || '').trim().slice(0, 200);
  if (expiresAt !== undefined) {
    if (expiresAt === null || expiresAt === '') {
      update.expiresAt = null;
    } else {
      const iso = new Date(expiresAt).toISOString();
      if (!Number.isFinite(new Date(iso).getTime())) {
        const err = new Error('expiresAt inválido');
        err.statusCode = 400;
        throw err;
      }
      update.expiresAt = iso;
    }
  }
  const result = await collection.updateOne({ id }, { $set: update });
  if (!result.matchedCount) {
    const err = new Error('Entrada não encontrada');
    err.statusCode = 404;
    throw err;
  }
  invalidateAllowlistCache();
  const updated = await collection.findOne({ id }, { projection: { _id: 0 } });
  return updated ? sanitizeEntry(updated) : null;
};

export const removeEntry = async (id) => {
  if (!adapter.db) await adapter.init();
  const collection = adapter.db.collection(COLLECTION);
  const result = await collection.deleteOne({ id });
  invalidateAllowlistCache();
  return Boolean(result.deletedCount);
};

export const purgeExpired = async () => {
  if (!adapter.db) await adapter.init();
  const collection = adapter.db.collection(COLLECTION);
  const result = await collection.deleteMany({
    expiresAt: { $ne: null, $lte: nowIso() }
  });
  if (result.deletedCount) invalidateAllowlistCache();
  return result.deletedCount || 0;
};
