import { envFlag, envInt } from '../utils/env.js';
import { enqueueCadenceProcessing } from '../queues/cadenceQueue.js';
import { enqueueTurizmoDelivery } from '../queues/turizmoQueue.js';
import { processNextCadenceExecution } from './cadenceEngine.js';
import { processNextTurizmoEvent } from './integrationOutbox.js';
import { releaseDueScheduledCampaigns, wakeOutreachCampaignWorker } from './outreachCampaignWorker.js';
import { enqueueCampaignProcessing } from '../queues/campaignQueue.js';

let timer = null;
let busy = false;
let runtimeUsesBullMq = false;

export const startCommercialRuntimeWorker = ({ bullMqOperational = false } = {}) => {
  if (timer) return timer;
  runtimeUsesBullMq = Boolean(bullMqOperational);
  const intervalMs = envInt('CADENCE_WORKER_INTERVAL_MS', 15000, { min: 1000, max: 300000 });
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const dueCampaigns = await releaseDueScheduledCampaigns();
      if (bullMqOperational) {
        await Promise.all([
          ...dueCampaigns.map((campaign) => enqueueCampaignProcessing({ campaignId: campaign.id, reason: 'scheduled_at_due' })),
          envFlag('CADENCE_ENGINE_ENABLED', false) ? enqueueCadenceProcessing({ reason: 'scheduler_tick' }) : null,
          envFlag('TURIZMO_INTEGRATION_ENABLED', false) ? enqueueTurizmoDelivery({}) : null
        ]);
      } else {
        if (dueCampaigns.length) wakeOutreachCampaignWorker();
        if (envFlag('CADENCE_ENGINE_ENABLED', false)) await processNextCadenceExecution();
        if (envFlag('TURIZMO_INTEGRATION_ENABLED', false)) await processNextTurizmoEvent();
      }
    } catch (error) {
      console.warn('[COMMERCIAL_RUNTIME] Tick falhou', { error: error?.message || error });
    } finally {
      busy = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 1000).unref?.();
  console.log('[COMMERCIAL_RUNTIME] Ativo', { intervalMs, bullMqOperational });
  return timer;
};

export const stopCommercialRuntimeWorker = () => {
  if (timer) clearInterval(timer);
  timer = null;
  runtimeUsesBullMq = false;
};

export const getCommercialRuntimeStatus = () => ({
  active: Boolean(timer),
  busy,
  bullMqOperational: runtimeUsesBullMq
});
