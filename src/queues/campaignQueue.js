import { addQueueJob, QUEUE_NAMES } from './index.js';

export const enqueueCampaignProcessing = async ({ campaignId = null, reason = 'wake' } = {}) => addQueueJob(
  QUEUE_NAMES.outreachCampaign,
  'process-outreach-campaign',
  { campaignId, reason },
  {
    jobId: campaignId ? `campaign-${campaignId}-${Date.now()}` : `campaign-wake-${Date.now()}`
  }
);
