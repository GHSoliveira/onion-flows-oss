import { addQueueJob, QUEUE_NAMES } from './index.js';

export const enqueueCampaignMetrics = async ({ tenantId, campaignId }) => addQueueJob(
  QUEUE_NAMES.metricsAggregation,
  'aggregate-campaign-metrics',
  { tenantId, campaignId },
  { jobId: `metrics-${tenantId}-${campaignId}-${Math.floor(Date.now() / 5000)}` }
);

