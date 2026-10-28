import { addQueueJob, QUEUE_NAMES } from './index.js';

export const enqueueWhatsAppSend = async (payload, options = {}) => addQueueJob(
  QUEUE_NAMES.whatsappSend,
  payload?.mediaType ? 'send-whatsapp-media' : 'send-whatsapp-text',
  payload,
  {
    jobId: options.jobId || `wa-send-${payload?.tenantId || 'global'}-${payload?.chatId || 'none'}-${Date.now()}`
  }
);
