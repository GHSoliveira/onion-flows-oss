import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { getRedisStatus, isBullMqEnabled, isRedisEnabled } from '../services/redisClient.js';
import { getQueuesMetrics } from '../queues/index.js';
import adapter from '../../db/DatabaseAdapter.js';
import { getTurizmoStatus } from '../services/integrationOutbox.js';
import { envFlag } from '../utils/env.js';
import { getCommercialRuntimeStatus } from '../services/commercialRuntimeWorker.js';
import { getBullMqWorkerStatus } from '../workers/index.js';
import { getOutreachCampaignMaxContacts, isOutreachCampaignWorkerActive } from '../services/outreachCampaignWorker.js';

const router = express.Router();

router.get('/queues', authenticate, authorize(['SUPER_ADMIN']), async (_req, res) => {
  try {
    const queues = await getQueuesMetrics();
    res.json({
      redis: getRedisStatus(),
      flags: {
        redisEnabled: isRedisEnabled(),
        bullMqEnabled: isBullMqEnabled()
      },
      queues
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Falha ao consultar filas' });
  }
});

router.get('/commercial-health', authenticate, authorize(['SUPER_ADMIN']), async (req, res) => {
  try {
    const tenantId = String(req.query.tenantId || '').trim() || null;
    const [turizmo] = await Promise.all([getTurizmoStatus({ tenantId })]);
    const redis = getRedisStatus();
    const bullMqEnabled = isBullMqEnabled();
    const bullMqWorkers = getBullMqWorkerStatus();
    const commercialRuntime = getCommercialRuntimeStatus();
    const aiEnabled = envFlag('AI_CLASSIFICATION_ENABLED', false);
    const aiProvider = String(process.env.AI_PROVIDER || 'openai').toLowerCase();
    const aiConfigured = ['rules', 'rule_based'].includes(aiProvider)
      || Boolean(process.env.AI_API_KEY || process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY);
    const cadenceEnabled = envFlag('CADENCE_ENGINE_ENABLED', false);
    res.json({
      database: {
        adapter: String(process.env.DB_ADAPTER || (envFlag('USE_JSON_DB', false) ? 'json' : 'mongodb')).toLowerCase(),
        ready: Boolean(adapter.db)
      },
      redis: { enabled: isRedisEnabled(), ready: Boolean(redis.ready) },
      bullmq: { enabled: bullMqEnabled, ready: bullMqEnabled && Boolean(redis.ready) && bullMqWorkers.active },
      ai: {
        enabled: aiEnabled,
        provider: aiEnabled ? aiProvider : null,
        model: aiEnabled ? (String(process.env.AI_MODEL || '').trim() || null) : null,
        configured: aiConfigured,
        fallbacks: aiEnabled ? [
          ...(process.env.GEMINI_API_KEY ? ['gemini'] : []),
          ...(process.env.GROQ_API_KEY ? ['groq'] : [])
        ] : []
      },
      cadence: { enabled: cadenceEnabled, workerActive: cadenceEnabled && commercialRuntime.active },
      turizmo: {
        enabled: turizmo.enabled,
        configured: turizmo.configured,
        circuitOpen: turizmo.circuitOpen,
        pendingEvents: Number(turizmo.counts?.pending || 0),
        retryEvents: Number(turizmo.counts?.retry || 0),
        deadLetterEvents: Number(turizmo.counts?.dead_letter || 0)
      },
      campaigns: {
        workerEnabled: isOutreachCampaignWorkerActive() || (bullMqEnabled && bullMqWorkers.active),
        maxContacts: getOutreachCampaignMaxContacts()
      },
      metrics: { v2Enabled: envFlag('OUTREACH_METRICS_V2_ENABLED', true) },
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Falha ao consultar saude comercial' });
  }
});

export default router;
