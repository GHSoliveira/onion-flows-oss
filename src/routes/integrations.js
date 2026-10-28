import express from 'express';
import adapter from '../../db/DatabaseAdapter.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import { createLog } from '../services/logs.js';
import { getTurizmoStatus, retryTurizmoEvent, testTurizmoIntegration } from '../services/integrationOutbox.js';
import { COLLECTIONS, pageFromQuery } from '../services/outreachDomain.js';
import { enqueueTurizmoDelivery } from '../queues/turizmoQueue.js';

const router = express.Router();
const controllerRoles = ['SUPER_ADMIN'];
router.use(authenticate, requireTenant, authorize(controllerRoles));

router.get('/turizmo/status', async (req, res) => {
  res.json(await getTurizmoStatus({ tenantId: req.tenantId }));
});

router.post('/turizmo/test', async (req, res) => {
  try {
    const result = await testTurizmoIntegration({ tenantId: req.tenantId });
    await createLog('TURIZMO_CONNECTIVITY_TEST', {
      tenantId: req.tenantId,
      outboxId: result.outboxId,
      eventId: result.eventId,
      durationMs: result.durationMs,
      turizmoStatus: result.turizmoStatus
    }, req.user.id);
    res.json(result);
  } catch (error) {
    res.status(Number(error?.status || 502)).json({
      code: error?.code || 'turizmo_unreachable',
      message: error?.message || 'Falha ao testar integracao Turizmo',
      correlationId: req.correlationId,
      ...(error?.outboxId ? { outboxId: error.outboxId, eventId: error.eventId, durationMs: error.durationMs, turizmoStatus: error.turizmoStatus } : {})
    });
  }
});

router.get('/turizmo/outbox', async (req, res) => {
  const { page, limit, skip } = pageFromQuery(req.query);
  const status = String(req.query.status || '').trim();
  const query = { tenantId: req.tenantId, destination: 'turizmo', ...(status ? { status } : {}) };
  const [items, total] = await Promise.all([
    adapter.findMany(COLLECTIONS.outbox, { query, projection: { _id: 0, 'payload.data': 0 }, sort: { createdAt: -1 }, skip, limit }),
    adapter.countDocuments(COLLECTIONS.outbox, query)
  ]);
  res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

router.post('/turizmo/outbox/:id/retry', async (req, res) => {
  const item = await retryTurizmoEvent({ tenantId: req.tenantId, outboxId: req.params.id });
  if (!item) return res.status(404).json({ code: 'outbox_not_found', message: 'Evento nao encontrado', correlationId: req.correlationId });
  await enqueueTurizmoDelivery({ outboxId: item.id });
  await createLog('TURIZMO_OUTBOX_RETRY', { tenantId: req.tenantId, outboxId: item.id, eventId: item.eventId }, req.user.id);
  res.status(202).json({ ok: true, item });
});

export default router;
