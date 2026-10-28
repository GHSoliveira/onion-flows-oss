import { Worker } from 'bullmq';
import { getRedisConnection, getRedisStatus, isBullMqEnabled } from '../services/redisClient.js';
import { handleWhatsAppWebhook } from '../services/whatsappHandler.js';
import { sendWhatsAppMedia, sendWhatsAppText } from '../services/whatsappApi.js';
import { processNextOutreachCampaign } from '../services/outreachCampaignWorker.js';
import { classifyMessage } from '../services/aiClassification.js';
import { processNextCadenceExecution, recoverStaleCadenceExecutions } from '../services/cadenceEngine.js';
import { processNextTurizmoEvent } from '../services/integrationOutbox.js';
import { calculateCampaignMetrics } from '../services/outreachMetrics.js';
import { addQueueJob, getQueueConcurrency, QUEUE_NAMES } from '../queues/index.js';
import { captureError } from '../services/errorTracking.js';

const workers = [];

const summarizeError = (error) => ({
  message: error?.message || 'job_failed',
  name: error?.name || null,
  status: error?.response?.status || error?.status || null
});

const logJob = ({ queueName, job, startedAt, status, error = null }) => {
  const durationMs = Date.now() - startedAt;
  const data = job?.data || {};
  const payload = {
    tenantId: data.tenantId || null,
    chatId: data.chatId || null,
    jobId: job?.id || null,
    queueName,
    durationMs,
    status,
    error: error ? summarizeError(error) : null
  };
  const method = status === 'failed' ? console.warn : console.log;
  method('[BULLMQ_JOB]', payload);
};

const createWorker = (queueName, processor) => {
  const connection = getRedisConnection();
  const worker = new Worker(queueName, async (job) => {
    const startedAt = Date.now();
    try {
      const result = await processor(job);
      logJob({ queueName, job, startedAt, status: 'completed' });
      return result;
    } catch (error) {
      logJob({ queueName, job, startedAt, status: 'failed', error });
      // So a ultima tentativa: as anteriores o BullMQ ainda vai repetir.
      if ((job?.attemptsMade || 0) + 1 >= (job?.opts?.attempts || 1)) {
        captureError(error, { tags: { queue: queueName, tenantId: job?.data?.tenantId }, extra: { jobId: job?.id } });
      }
      throw error;
    }
  }, {
    connection,
    concurrency: getQueueConcurrency(queueName)
  });

  worker.on('failed', (job, error) => {
    console.warn('[BULLMQ_WORKER] Job falhou', {
      queueName,
      jobId: job?.id || null,
      attemptsMade: job?.attemptsMade || 0,
      error: error?.message || 'job_failed'
    });
  });

  workers.push(worker);
  return worker;
};

const scheduleCampaignDrain = async ({ delay = 500 } = {}) => {
  await addQueueJob(
    QUEUE_NAMES.outreachCampaign,
    'process-outreach-campaign',
    { reason: 'drain' },
    { jobId: `campaign-drain-${Date.now()}`, delay }
  );
};

const scheduleDomainDrains = async ({ delay = 1000 } = {}) => {
  await Promise.all([
    addQueueJob(QUEUE_NAMES.cadenceScheduler, 'process-cadence-execution', { reason: 'drain' }, { jobId: `cadence-drain-${Date.now()}`, delay }),
    addQueueJob(QUEUE_NAMES.turizmoEvents, 'deliver-turizmo-event', { reason: 'drain' }, { jobId: `turizmo-drain-${Date.now()}`, delay })
  ]);
};

export const startBullMqWorkers = async () => {
  if (!isBullMqEnabled()) {
    console.log('[BULLMQ] Desligado por configuracao');
    return [];
  }

  if (!getRedisConnection() || !getRedisStatus().ready) {
    console.warn('[BULLMQ] Redis indisponivel. Workers nao iniciados; fallback local ativo.');
    return [];
  }

  if (workers.length > 0) return workers;

  createWorker(QUEUE_NAMES.whatsappWebhook, async (job) => {
    if (job.name === 'smoke-noop') return { ok: true, smoke: true };
    await handleWhatsAppWebhook({
      payload: job.data?.payload,
      tenantId: job.data?.tenantId || null
    });
    return { ok: true };
  });

  createWorker(QUEUE_NAMES.whatsappSend, async (job) => {
    const data = job.data || {};
    if (data.mediaType || data.mediaUrl) {
      return sendWhatsAppMedia(data);
    }
    return sendWhatsAppText(data);
  });

  createWorker(QUEUE_NAMES.outreachCampaign, async () => {
    const result = await processNextOutreachCampaign();
    if (result?.deferredUntil) {
      const delay = Math.max(500, Math.min(60 * 60 * 1000, new Date(result.deferredUntil).getTime() - Date.now()));
      await scheduleCampaignDrain({ delay });
    } else if (result && !result.idle) {
      await scheduleCampaignDrain({ delay: 500 });
    }
    return result || { ok: true };
  });

  createWorker(QUEUE_NAMES.leadClassification, async (job) => classifyMessage({
    tenantId: job.data?.tenantId,
    messageId: job.data?.messageId,
    force: Boolean(job.data?.force),
    classificationId: job.data?.classificationId || null,
    reprocessRequestId: job.data?.reprocessRequestId || null
  }));

  createWorker(QUEUE_NAMES.cadenceScheduler, async (job) => {
    const result = await processNextCadenceExecution({ executionId: job.data?.executionId || null });
    if (result && !result.idle) {
      await addQueueJob(QUEUE_NAMES.cadenceScheduler, 'process-cadence-execution', { reason: 'drain' }, { jobId: `cadence-drain-${Date.now()}`, delay: 250 });
    }
    return result;
  });

  createWorker(QUEUE_NAMES.turizmoEvents, async (job) => {
    const result = await processNextTurizmoEvent({ outboxId: job.data?.outboxId || null });
    if (result && !result.idle) {
      await addQueueJob(QUEUE_NAMES.turizmoEvents, 'deliver-turizmo-event', { reason: 'drain' }, { jobId: `turizmo-drain-${Date.now()}`, delay: result.retry ? 2000 : 250 });
    }
    return result;
  });

  createWorker(QUEUE_NAMES.metricsAggregation, async (job) => calculateCampaignMetrics({
    tenantId: job.data?.tenantId,
    campaignId: job.data?.campaignId
  }));

  await scheduleCampaignDrain({ delay: 1000 }).catch((error) => {
    console.warn('[BULLMQ] Falha ao agendar drain inicial de campanhas:', error?.message || error);
  });
  await recoverStaleCadenceExecutions().catch((error) => {
    console.warn('[CADENCE] Falha ao recuperar execucoes', error?.message || error);
  });
  await scheduleDomainDrains({ delay: 1500 }).catch((error) => {
    console.warn('[BULLMQ] Falha ao agendar domain drains:', error?.message || error);
  });

  console.log('[BULLMQ] Workers iniciados', {
    queues: Object.values(QUEUE_NAMES).map((name) => ({
      name,
      concurrency: getQueueConcurrency(name)
    }))
  });

  return workers;
};

export const closeBullMqWorkers = async () => {
  await Promise.all(workers.map((worker) => worker.close().catch(() => null)));
  workers.length = 0;
};

export const getBullMqWorkerStatus = () => ({
  active: workers.length > 0,
  count: workers.length
});
