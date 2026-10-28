import '../src/config/env.js';
import { initRedis, closeRedis, getRedisStatus, isBullMqEnabled } from '../src/services/redisClient.js';
import { addQueueJob, getQueuesMetrics, QUEUE_NAMES, closeQueues } from '../src/queues/index.js';

await initRedis();
console.log('[SMOKE] Redis status:', getRedisStatus());

if (!isBullMqEnabled()) {
  console.log('[SMOKE] BULLMQ_ENABLED=false ou Redis desligado. Fallback esperado.');
  process.exitCode = 0;
} else {
  const job = await addQueueJob(
    QUEUE_NAMES.whatsappWebhook,
    'smoke-noop',
    { tenantId: 'smoke', chatId: null },
    { jobId: `smoke-${Date.now()}` }
  );
  console.log('[SMOKE] Job criado:', { id: job?.id || null, queue: QUEUE_NAMES.whatsappWebhook });
  console.log('[SMOKE] Metrics:', await getQueuesMetrics());
}

await closeQueues();
await closeRedis();
