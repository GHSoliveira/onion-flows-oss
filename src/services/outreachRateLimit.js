import { envInt } from '../utils/env.js';
import { getRedisConnection, getRedisStatus } from './redisClient.js';

const localBuckets = new Map();

const bucketSpecs = () => [
  { name: 'minute', seconds: 60, limit: envInt('OUTREACH_MAX_PER_MINUTE', 30, { min: 1, max: 100000 }) },
  { name: 'hour', seconds: 3600, limit: envInt('OUTREACH_MAX_PER_HOUR', 500, { min: 1, max: 1000000 }) },
  { name: 'day', seconds: 86400, limit: envInt('OUTREACH_MAX_PER_DAY', 5000, { min: 1, max: 10000000 }) }
];

const localConsume = (key, spec, now) => {
  const current = localBuckets.get(key);
  if (!current || current.expiresAt <= now) {
    localBuckets.set(key, { count: 1, expiresAt: now + (spec.seconds * 1000) });
    return { allowed: true, retryAt: null };
  }
  if (current.count >= spec.limit) return { allowed: false, retryAt: new Date(current.expiresAt).toISOString() };
  current.count += 1;
  return { allowed: true, retryAt: null };
};

export const consumeOutreachQuota = async ({ tenantId, senderPhoneNumberId = 'default' }) => {
  const now = Date.now();
  const redis = getRedisConnection();
  const redisReady = Boolean(redis && getRedisStatus().ready);
  for (const spec of bucketSpecs()) {
    const window = Math.floor(now / (spec.seconds * 1000));
    const key = `outreach:quota:${tenantId}:${senderPhoneNumberId}:${spec.name}:${window}`;
    if (redisReady) {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, spec.seconds + 5);
      if (count > spec.limit) {
        const ttl = Math.max(1, await redis.ttl(key));
        return { allowed: false, reason: `${spec.name}_limit`, retryAt: new Date(now + ttl * 1000).toISOString() };
      }
      continue;
    }
    const result = localConsume(key, spec, now);
    if (!result.allowed) return { ...result, reason: `${spec.name}_limit` };
  }
  return { allowed: true };
};

export const waitOutreachJitter = async () => {
  const min = envInt('OUTREACH_SEND_JITTER_MIN_MS', 250, { min: 0, max: 60000 });
  const max = envInt('OUTREACH_SEND_JITTER_MAX_MS', 1500, { min, max: 60000 });
  const delay = min + Math.floor(Math.random() * Math.max(1, max - min + 1));
  if (delay <= 0) return 0;
  await new Promise((resolve) => setTimeout(resolve, delay));
  return delay;
};

