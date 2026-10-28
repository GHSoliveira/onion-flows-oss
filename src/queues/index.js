import { Queue } from 'bullmq';
import { getRedisConnection, getRedisStatus, isBullMqEnabled } from '../services/redisClient.js';
import { envInt } from '../utils/env.js';

export const QUEUE_NAMES = {
  whatsappWebhook: 'whatsapp-webhook',
  whatsappSend: 'whatsapp-send',
  outreachCampaign: 'outreach-campaign',
  leadClassification: 'lead-classification',
  cadenceScheduler: 'cadence-scheduler',
  turizmoEvents: 'turizmo-events',
  metricsAggregation: 'metrics-aggregation'
};

const queues = new Map();

export const getQueueConcurrency = (name) => {
  if (name === QUEUE_NAMES.whatsappWebhook) {
    return envInt('WEBHOOK_QUEUE_CONCURRENCY', 5, { min: 1, max: 50 });
  }
  if (name === QUEUE_NAMES.whatsappSend) {
    return envInt('WHATSAPP_QUEUE_CONCURRENCY', 5, { min: 1, max: 50 });
  }
  if (name === QUEUE_NAMES.outreachCampaign) {
    return envInt('CAMPAIGN_QUEUE_CONCURRENCY', 2, { min: 1, max: 20 });
  }
  if (name === QUEUE_NAMES.leadClassification) {
    return envInt('AI_CLASSIFICATION_QUEUE_CONCURRENCY', 3, { min: 1, max: 20 });
  }
  if (name === QUEUE_NAMES.cadenceScheduler) {
    return envInt('CADENCE_QUEUE_CONCURRENCY', 2, { min: 1, max: 20 });
  }
  if (name === QUEUE_NAMES.turizmoEvents) {
    return envInt('TURIZMO_QUEUE_CONCURRENCY', 3, { min: 1, max: 20 });
  }
  if (name === QUEUE_NAMES.metricsAggregation) {
    return envInt('METRICS_QUEUE_CONCURRENCY', 2, { min: 1, max: 20 });
  }
  return 1;
};

export const getQueue = (name) => {
  if (!isBullMqEnabled()) return null;
  const connection = getRedisConnection();
  if (!connection || !getRedisStatus().ready) return null;
  if (queues.has(name)) return queues.get(name);
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400, count: 5000 }
    }
  });
  queues.set(name, queue);
  return queue;
};

export const queueAvailable = (name) => Boolean(getQueue(name));

export const addQueueJob = async (queueName, jobName, payload, options = {}) => {
  const queue = getQueue(queueName);
  if (!queue) return null;
  return queue.add(jobName, payload, {
    ...options,
    jobId: options.jobId || undefined
  });
};

export const getQueuesMetrics = async () => {
  const names = Object.values(QUEUE_NAMES);
  const metrics = [];
  for (const name of names) {
    const queue = getQueue(name);
    if (!queue) {
      metrics.push({ name, enabled: false });
      continue;
    }
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'paused');
    metrics.push({
      name,
      enabled: true,
      concurrency: getQueueConcurrency(name),
      counts
    });
  }
  return metrics;
};

export const closeQueues = async () => {
  await Promise.all(Array.from(queues.values()).map((queue) => queue.close().catch(() => null)));
  queues.clear();
};
