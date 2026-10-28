import { addQueueJob, QUEUE_NAMES } from './index.js';
import { envInt } from '../utils/env.js';
import { createDomainId } from '../services/outreachDomain.js';

export const enqueueLeadClassification = async ({
  tenantId,
  messageId,
  force = false,
  classificationId = null,
  reprocessRequestId = null
}) => {
  const requestId = force ? (reprocessRequestId || createDomainId('classification_reprocess')) : null;
  const job = await addQueueJob(
    QUEUE_NAMES.leadClassification,
    'classify-lead-reply',
    { tenantId, messageId, force, classificationId, reprocessRequestId: requestId },
    {
      jobId: `classification-${tenantId}-${messageId}-${requestId || 'v1'}`,
      attempts: envInt('AI_CLASSIFICATION_MAX_ATTEMPTS', 5, { min: 1, max: 20 }),
      backoff: { type: 'exponential', delay: envInt('AI_CLASSIFICATION_BACKOFF_MS', 2000, { min: 100, max: 60000 }) }
    }
  );
  if (job) return job;
  setTimeout(() => {
    import('../services/aiClassification.js')
      .then(({ classifyMessage }) => classifyMessage({
        tenantId,
        messageId,
        force,
        classificationId,
        reprocessRequestId: requestId
      }))
      .catch((error) => console.warn('[AI_CLASSIFICATION] Fallback local falhou', { tenantId, messageId, error: error?.message || error }));
  }, 0).unref?.();
  return { queued: false, reprocessRequestId: requestId };
};
