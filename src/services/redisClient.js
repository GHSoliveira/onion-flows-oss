import IORedis from 'ioredis';
import { envFlag } from '../utils/env.js';

let redisConnection = null;
let redisStatus = {
  enabled: false,
  ready: false,
  urlConfigured: false,
  lastError: null
};

const maskRedisUrl = (url) => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch (_error) {
    return 'redis://***';
  }
};

export const isRedisEnabled = () => envFlag('REDIS_ENABLED', false);

export const isBullMqEnabled = () => envFlag('BULLMQ_ENABLED', false) && isRedisEnabled();

export const getRedisStatus = () => ({ ...redisStatus });

export const getRedisConnection = () => {
  if (!isRedisEnabled()) return null;
  return redisConnection;
};

export const initRedis = async () => {
  const enabled = isRedisEnabled();
  const redisUrl = String(process.env.REDIS_URL || '').trim();

  redisStatus = {
    enabled,
    ready: false,
    urlConfigured: Boolean(redisUrl),
    lastError: null
  };

  if (!enabled) {
    console.log('[REDIS] Desligado por configuracao');
    return null;
  }

  if (!redisUrl) {
    redisStatus.lastError = 'REDIS_URL ausente';
    console.warn('[REDIS] REDIS_ENABLED=true, mas REDIS_URL nao foi definida. Fallback local ativo.');
    return null;
  }

  if (redisConnection) return redisConnection;

  const connection = new IORedis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: 5000
  });

  connection.on('error', (error) => {
    redisStatus.ready = false;
    redisStatus.lastError = error?.message || 'redis_error';
    console.warn('[REDIS] Erro de conexao:', redisStatus.lastError);
  });

  connection.on('ready', () => {
    redisStatus.ready = true;
    redisStatus.lastError = null;
  });

  try {
    await connection.connect();
    redisConnection = connection;
    redisStatus.ready = true;
    console.log('[REDIS] Conectado', { url: maskRedisUrl(redisUrl) });
    return redisConnection;
  } catch (error) {
    redisStatus.ready = false;
    redisStatus.lastError = error?.message || 'redis_connect_failed';
    console.warn('[REDIS] Falha ao conectar. Fallback local ativo:', redisStatus.lastError);
    try {
      connection.disconnect();
    } catch (_disconnectError) {
      // best effort
    }
    return null;
  }
};

export const closeRedis = async () => {
  if (!redisConnection) return;
  const connection = redisConnection;
  redisConnection = null;
  redisStatus.ready = false;
  await connection.quit().catch(() => connection.disconnect());
};

export const redisGetJson = async (key) => {
  const connection = getRedisConnection();
  if (!connection || !redisStatus.ready) return undefined;
  try {
    const raw = await connection.get(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch (error) {
    redisStatus.lastError = error?.message || 'redis_get_failed';
    return undefined;
  }
};

export const redisSetJson = async (key, value, ttlSeconds) => {
  const connection = getRedisConnection();
  if (!connection || !redisStatus.ready) return false;
  try {
    const payload = JSON.stringify(value);
    if (ttlSeconds > 0) {
      await connection.set(key, payload, 'EX', ttlSeconds);
    } else {
      await connection.set(key, payload);
    }
    return true;
  } catch (error) {
    redisStatus.lastError = error?.message || 'redis_set_failed';
    return false;
  }
};

export const redisDelete = async (...keys) => {
  const connection = getRedisConnection();
  const normalized = keys.flat().filter(Boolean);
  if (!connection || !redisStatus.ready || normalized.length === 0) return false;
  try {
    await connection.del(normalized);
    return true;
  } catch (error) {
    redisStatus.lastError = error?.message || 'redis_del_failed';
    return false;
  }
};

export const redisDeleteByPattern = async (pattern) => {
  const connection = getRedisConnection();
  if (!connection || !redisStatus.ready || !pattern) return false;
  try {
    const stream = connection.scanStream({ match: pattern, count: 200 });
    const batches = [];
    for await (const keys of stream) {
      if (Array.isArray(keys) && keys.length) batches.push(connection.del(keys));
    }
    await Promise.all(batches);
    return true;
  } catch (error) {
    redisStatus.lastError = error?.message || 'redis_scan_del_failed';
    return false;
  }
};
