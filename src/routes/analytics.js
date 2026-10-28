import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import { getBottlenecks, getFunnel, getOverview, getTimeseries } from '../services/analyticsService.js';
import { getMonthlyAnalytics } from '../services/monthlyAnalytics.js';

const router = express.Router();

const allowedRoles = ['ADMIN', 'MANAGER'];

router.get('/monthly', authenticate, requireTenant, authorize(allowedRoles, { permission: 'operacao.ver' }), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    res.json(await getMonthlyAnalytics({ tenantId: req.tenantId, month: String(req.query.month || ''), channel: req.query.channel ? String(req.query.channel) : null }));
  } catch (error) {
    const status = [400, 422, 503].includes(error.status) ? error.status : 500;
    res.status(status).json({ error: status === 500 ? 'Nao foi possivel carregar o relatorio mensal.' : error.message });
  }
});

const extractCommonParams = (req) => ({
  tenantId: req.tenantId,
  from: req.query.from || null,
  to: req.query.to || null,
  channel: String(req.query.channel || '').trim() || null,
  queue: String(req.query.queue || '').trim() || null
});

router.get('/overview', authenticate, requireTenant, authorize(allowedRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try {
    const data = await getOverview(extractCommonParams(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/timeseries', authenticate, requireTenant, authorize(allowedRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try {
    const bucket = String(req.query.bucket || 'hour').trim().toLowerCase();
    const data = await getTimeseries({ ...extractCommonParams(req), bucket });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/funnel', authenticate, requireTenant, authorize(allowedRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try {
    const data = await getFunnel(extractCommonParams(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/bottlenecks', authenticate, requireTenant, authorize(allowedRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try {
    const data = await getBottlenecks(extractCommonParams(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
