import { addQueueJob, QUEUE_NAMES } from './index.js';

export const enqueueTurizmoDelivery = async ({ outboxId = null, delay = 0 } = {}) => {
  const job = await addQueueJob(
    QUEUE_NAMES.turizmoEvents,
    'deliver-turizmo-event',
    { outboxId },
    { jobId: outboxId ? `turizmo-${outboxId}-${Date.now()}` : `turizmo-drain-${Date.now()}`, delay }
  );
  if (job) return job;
  setTimeout(() => {
    import('../services/integrationOutbox.js')
      .then(({ processNextTurizmoEvent }) => processNextTurizmoEvent({ outboxId }))
      .catch((error) => console.warn('[TURIZMO] Fallback local falhou', { outboxId, error: error?.message || error }));
  }, 0).unref?.();
  return null;
};

