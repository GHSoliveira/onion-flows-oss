import crypto from 'crypto';
import { addQueueJob, QUEUE_NAMES } from './index.js';

export const enqueueWhatsAppWebhook = async ({ payload, tenantId = null, signature = null }) => {
  const stableId = signature
    || payload?.entry?.[0]?.id
    || crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');

  return addQueueJob(
    QUEUE_NAMES.whatsappWebhook,
    'process-whatsapp-webhook',
    { payload, tenantId },
    { jobId: `wa-webhook-${String(stableId).replace(/:/g, '-')}` }
  );
};
