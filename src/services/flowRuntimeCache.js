import {
  redisDelete,
  redisDeleteByPattern,
  redisGetJson,
  redisSetJson
} from './redisClient.js';

const DEFAULT_TTL_MS = 60000;

const parseTtl = (rawValue) => {
  const value = Number.parseInt(String(rawValue || '').trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TTL_MS;
};

const CACHE_TTL_MS = parseTtl(process.env.FLOW_RUNTIME_CACHE_TTL_MS);
const CACHE_TTL_SECONDS = Math.max(1, Math.ceil(CACHE_TTL_MS / 1000));

const flowCache = new Map();
const templateCache = new Map();
const scheduleCache = new Map();

const isFresh = (entry) => Boolean(entry?.at) && (Date.now() - entry.at) < CACHE_TTL_MS;

const buildFlowKey = (tenantId, flowId = null) => `${String(tenantId || '')}::${String(flowId || '__default__')}`;
const buildRedisKey = (namespace, key) => `runtime:${namespace}:${key}`;

const getCachedValue = async (store, key, loader) => {
  const entry = store.get(key);
  if (entry && isFresh(entry) && Object.prototype.hasOwnProperty.call(entry, 'value')) {
    return entry.value;
  }

  if (entry?.pending) {
    return entry.pending;
  }

  const pending = Promise.resolve()
    .then(loader)
    .then((value) => {
      store.set(key, { value, at: Date.now() });
      return value;
    })
    .catch((error) => {
      store.delete(key);
      throw error;
    });

  store.set(key, { pending });
  return pending;
};

const getHybridCachedValue = async (namespace, store, key, loader) => {
  const entry = store.get(key);
  if (entry && isFresh(entry) && Object.prototype.hasOwnProperty.call(entry, 'value')) {
    return entry.value;
  }

  const redisKey = buildRedisKey(namespace, key);
  const redisValue = await redisGetJson(redisKey);
  if (redisValue !== undefined) {
    store.set(key, { value: redisValue, at: Date.now() });
    return redisValue;
  }

  const value = await getCachedValue(store, key, loader);
  redisSetJson(redisKey, value, CACHE_TTL_SECONDS).catch(() => null);
  return value;
};

// Grafo que o motor executa (versao publicada) com o id e o nome do fluxo junto,
// para a conversa saber qual fluxo a atendeu (painel e relatorios).
export const toRuntimeFlow = (flow) => (flow
  ? { ...(flow.published || flow), flowId: flow.id || null, flowName: flow.name || null }
  : null);

export const getCachedRuntimeFlow = async ({ tenantId, flowId = null, loader }) => {
  if (!tenantId || typeof loader !== 'function') {
    return null;
  }
  return getHybridCachedValue('flow', flowCache, buildFlowKey(tenantId, flowId), loader);
};

export const getCachedRuntimeTemplates = async ({ tenantId, loader }) => {
  if (!tenantId || typeof loader !== 'function') {
    return [];
  }
  return getHybridCachedValue('templates', templateCache, String(tenantId), loader);
};

export const getCachedRuntimeSchedules = async ({ tenantId, loader }) => {
  if (!tenantId || typeof loader !== 'function') {
    return [];
  }
  return getHybridCachedValue('schedules', scheduleCache, String(tenantId), loader);
};

export const invalidateRuntimeFlowCache = (tenantId = null, flowId = null) => {
  if (!tenantId) {
    flowCache.clear();
    redisDeleteByPattern('runtime:flow:*').catch(() => null);
    return;
  }

  if (flowId) {
    const exactKey = buildFlowKey(tenantId, flowId);
    flowCache.delete(exactKey);
    redisDelete(buildRedisKey('flow', exactKey)).catch(() => null);
  }

  const prefix = `${String(tenantId)}::`;
  Array.from(flowCache.keys()).forEach((key) => {
    if (key.startsWith(prefix)) {
      flowCache.delete(key);
    }
  });
  redisDeleteByPattern(`runtime:flow:${prefix}*`).catch(() => null);
};

export const invalidateRuntimeTemplatesCache = (tenantId = null) => {
  if (!tenantId) {
    templateCache.clear();
    redisDeleteByPattern('runtime:templates:*').catch(() => null);
    return;
  }
  templateCache.delete(String(tenantId));
  redisDelete(buildRedisKey('templates', String(tenantId))).catch(() => null);
};

export const invalidateRuntimeSchedulesCache = (tenantId = null) => {
  if (!tenantId) {
    scheduleCache.clear();
    redisDeleteByPattern('runtime:schedules:*').catch(() => null);
    return;
  }
  scheduleCache.delete(String(tenantId));
  redisDelete(buildRedisKey('schedules', String(tenantId))).catch(() => null);
};

export const invalidateRuntimeCaches = (tenantId = null) => {
  invalidateRuntimeFlowCache(tenantId);
  invalidateRuntimeTemplatesCache(tenantId);
  invalidateRuntimeSchedulesCache(tenantId);
};
