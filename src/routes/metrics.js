import express from 'express';
import jwt from 'jsonwebtoken';
import adapter from '../../db/DatabaseAdapter.js';
import { JWT_SECRET_VALUE } from '../config/constants.js';

import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import { getBottlenecks, getOverview } from '../services/analyticsService.js';
import { COLLECTIONS } from '../services/outreachDomain.js';
import { generateId } from '../utils/helpers.js';

const router = express.Router();
const MAX_METRICS = 1000;
const ALLOWED_METRICS = new Set(['CLS', 'FID', 'FCP', 'INP', 'LCP', 'TTFB']);
let metricWritesSinceCleanup = 0;
let metricCleanupRunning = false;

const cleanupWebVitals = async () => {
  if (metricCleanupRunning) return;
  metricCleanupRunning = true;
  try {
    const total = await adapter.countDocuments('webVitals');
    if (total <= MAX_METRICS) return;
    const obsolete = await adapter.findMany('webVitals', {
      projection: { _id: 1 },
      sort: { timestamp: -1 },
      skip: MAX_METRICS
    });
    if (obsolete.length > 0) {
      await adapter.deleteMany('webVitals', {
        _id: { $in: obsolete.map((item) => item._id) }
      });
    }
  } finally {
    metricCleanupRunning = false;
  }
};

router.post('/web-vitals', authenticate, async (req, res) => {
  try {
    const metric = req.body || {};
    if (!metric || !metric.name || !ALLOWED_METRICS.has(metric.name)) {
      return res.status(400).json({ error: 'Invalid metric' });
    }

    const user = req.user;
    const payload = {
      id: generateId('wv'),
      timestamp: new Date().toISOString(),
      name: metric.name,
      value: metric.value,
      rating: metric.rating,
      delta: metric.delta,
      navigationType: metric.navigationType || null,
      page: metric.page || null,
      userId: user?.id || null,
      tenantId: user?.tenantId || null
    };

    await adapter.insertOne('webVitals', payload);

    metricWritesSinceCleanup += 1;
    if (metricWritesSinceCleanup >= 50) {
      metricWritesSinceCleanup = 0;
      cleanupWebVitals().catch(() => {});
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tenant', authenticate, requireTenant, authorize(['ADMIN', 'MANAGER'], { permission: 'operacao.ver' }), async (req, res) => {
  try {
    const from = req.query.from || null;
    const to = req.query.to || null;
    const [overview, operational] = await Promise.all([
      getOverview({ tenantId: req.tenantId, from, to }),
      getBottlenecks({ tenantId: req.tenantId, from, to })
    ]);
    const itemQuery = { tenantId: req.tenantId };
    if (from || to) itemQuery.createdAt = { ...(from ? { $gte: new Date(from).toISOString() } : {}), ...(to ? { $lte: new Date(to).toISOString() } : {}) };
    const items = await adapter.findMany(COLLECTIONS.campaignItems, {
      query: itemQuery,
      projection: { _id: 0, status: 1, intent: 1, firstResponseTimeMs: 1 },
      limit: 100000
    });
    const positiveIntents = new Set(['positivo', 'pediu_demo', 'pediu_preco', 'pediu_proposta']);
    const responseTimes = items.map((item) => Number(item.firstResponseTimeMs)).filter(Number.isFinite);
    res.json({
      range: overview?.range || { from, to },
      conversations: {
        received: overview?.entradas || 0,
        attended: overview?.atendidosHumano || 0,
        lost: overview?.perdidosNaFila || 0,
        waiting: overview?.emFila || 0,
        averageWaitMinutes: overview?.tempoMedioEsperaMin ?? null
      },
      agents: operational?.agentes || [],
      outreach: {
        total: items.length,
        replied: items.filter((item) => ['replied', 'classified', 'qualified'].includes(item.status)).length,
        positive: items.filter((item) => positiveIntents.has(item.intent)).length,
        demosRequested: items.filter((item) => item.intent === 'pediu_demo').length,
        optOuts: items.filter((item) => item.status === 'opted_out' || item.intent === 'opt_out').length,
        averageFirstResponseMs: responseTimes.length
          ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length)
          : null
      }
    });
  } catch (error) {
    res.status(500).json({ code: 'tenant_metrics_failed', message: 'Falha ao calcular metricas do tenant', correlationId: req.correlationId });
  }
});

export default router;
