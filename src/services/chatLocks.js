import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import { getRedisConnection, getRedisStatus, isRedisEnabled } from './redisClient.js';
import { envFlag, envInt } from '../utils/env.js';

const lockChains = new Map();
const lockContext = new AsyncLocalStorage();
const DISTRIBUTED_LOCK_ENABLED = envFlag('CHAT_DISTRIBUTED_LOCK_ENABLED', true);
const LOCK_TTL_MS = envInt('CHAT_LOCK_TTL_MS', 30000, { min: 5000, max: 300000 });
const LOCK_WAIT_MS = envInt('CHAT_LOCK_WAIT_MS', 10000, { min: 100, max: 120000 });
const LOCK_RETRY_MS = envInt('CHAT_LOCK_RETRY_MS', 50, { min: 10, max: 1000 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sanitizeRedisLockKey = (key) => String(key || '').replace(/[^a-zA-Z0-9:_-]/g, '_');

const acquireDistributedLock = async (key) => {
  if (!DISTRIBUTED_LOCK_ENABLED || !isRedisEnabled() || !getRedisStatus().ready) {
    return null;
  }

  const redis = getRedisConnection();
  if (!redis) return null;

  const token = crypto.randomUUID();
  const lockKey = `lock:${sanitizeRedisLockKey(key)}`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (Date.now() <= deadline) {
    try {
      const acquired = await redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX');
      if (acquired === 'OK') return { lockKey, token };
    } catch (error) {
      console.warn('[CHAT_LOCK] Redis lock indisponivel; usando lock local', {
        key,
        error: error?.message || 'lock_failed'
      });
      return null;
    }
    await sleep(LOCK_RETRY_MS);
  }

  const error = new Error('Timeout ao aguardar lock distribuido do chat');
  error.code = 'CHAT_LOCK_TIMEOUT';
  throw error;
};

const releaseDistributedLock = async (lock) => {
  if (!lock?.lockKey || !lock?.token) return;
  const redis = getRedisConnection();
  if (!redis || !getRedisStatus().ready) return;
  try {
    await redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1,
      lock.lockKey,
      lock.token
    );
  } catch (error) {
    console.warn('[CHAT_LOCK] Falha ao liberar lock distribuido', {
      key: lock.lockKey,
      error: error?.message || 'unlock_failed'
    });
  }
};

export const withLock = async (key, task) => {
  if (!key || typeof task !== 'function') {
    return typeof task === 'function' ? task() : undefined;
  }

  const currentContext = lockContext.getStore();
  if (currentContext?.has(key)) {
    return task();
  }

  const previous = lockChains.get(key) || Promise.resolve();
  let releaseCurrent = null;
  const currentGate = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const currentChain = previous.then(() => currentGate);
  lockChains.set(key, currentChain);

  await previous;

  let distributedLock = null;
  try {
    distributedLock = await acquireDistributedLock(key);
    const nextContext = new Set(currentContext ? Array.from(currentContext) : []);
    nextContext.add(key);
    return await lockContext.run(nextContext, task);
  } finally {
    await releaseDistributedLock(distributedLock);
    releaseCurrent?.();
    if (lockChains.get(key) === currentChain) {
      lockChains.delete(key);
    }
  }
};

// Roda `fn` fora de qualquer lock herdado. Timer ou callback criado dentro de um
// withLock carrega o contexto e, sem isto, passaria direto pelo lock depois
// (o reentrante acha que ja o possui), mesmo com o lock original ja liberado ou
// segurado por outra tarefa.
export const runOutsideChatLocks = (fn) => lockContext.exit(fn);

export const withChatLock = async (chatId, task) => withLock(
  chatId ? `chat:${String(chatId)}` : null,
  task
);

export const withChannelUserLock = async ({ channel, tenantId, userId }, task) => withLock(
  [channel || 'channel', tenantId || 'global', userId || 'unknown'].join(':'),
  task
);
