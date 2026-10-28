import { addQueueJob, QUEUE_NAMES } from './index.js';

export const enqueueCadenceProcessing = async ({ executionId = null, delay = 0, reason = 'due' } = {}) => addQueueJob(
  QUEUE_NAMES.cadenceScheduler,
  'process-cadence-execution',
  { executionId, reason },
  { jobId: executionId ? `cadence-${executionId}-${Date.now()}` : `cadence-drain-${Date.now()}`, delay }
);

