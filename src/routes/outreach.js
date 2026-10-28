import express from 'express';
import { z } from 'zod';
import adapter from '../../db/DatabaseAdapter.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import { createLog } from '../services/logs.js';
import {
  createOutreachCampaign, getOutreachCampaignById, listOutreachCampaigns,
  getOutreachCampaignMaxContacts, wakeOutreachCampaignWorker
} from '../services/outreachCampaignWorker.js';
import { calculateCampaignMetrics } from '../services/outreachMetrics.js';
import { listSuppressions, removeSuppression, suppressContact } from '../services/contactSuppression.js';
import { COLLECTIONS, pageFromQuery, nowIso } from '../services/outreachDomain.js';
import { enqueueCampaignProcessing } from '../queues/campaignQueue.js';
import { isBullMqEnabled } from '../services/redisClient.js';
import { envFlag } from '../utils/env.js';
import { pendingQualitySignalsForResume } from '../services/outreachQualityGuard.js';
import { isTenantBillingPaused } from '../services/billingGuard.js';

const router = express.Router();
const readRoles = ['ADMIN', 'MANAGER'];
const writeRoles = ['ADMIN'];

const valuesSchema = z.record(z.string(), z.unknown()).default({});
const campaignSchema = z.object({
  name: z.string().trim().min(1).max(160),
  channel: z.literal('whatsapp').default('whatsapp'),
  contactIds: z.array(z.string().trim().min(1)).min(1).max(1000),
  templateId: z.string().trim().min(1),
  senderPhoneNumberId: z.string().trim().nullable().optional(),
  values: valuesSchema.optional(),
  cadenceId: z.string().trim().nullable().optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  timezone: z.string().trim().max(80).default('America/Sao_Paulo'),
  turizmoLeadByContactId: z.record(z.string(), z.string()).optional(),
  turizmoCompanyByContactId: z.record(z.string(), z.string()).optional()
}).strict();

router.use(authenticate, requireTenant);

router.get('/capabilities', authorize(readRoles, { permission: 'operacao.ver' }), (req, res) => {
  const managerCampaignAccess = envFlag('CLIENT_CAMPAIGN_ACCESS_ENABLED', false);
  res.json({
    campaignRead: req.user.role !== 'MANAGER' || managerCampaignAccess,
    campaignWrite: req.user.role === 'SUPER_ADMIN' || req.user.role === 'ADMIN',
    cadenceRead: req.user.role !== 'MANAGER' || managerCampaignAccess,
    classificationReview: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(req.user.role),
    metricsV2: envFlag('OUTREACH_METRICS_V2_ENABLED', true)
  });
});

const requireCampaignAccess = (req, res, next) => {
  if (req.user.role !== 'MANAGER' || envFlag('CLIENT_CAMPAIGN_ACCESS_ENABLED', false)) return next();
  return res.status(403).json({
    code: 'campaign_access_disabled',
    message: 'O acesso do cliente a campanhas nao esta habilitado',
    correlationId: req.correlationId
  });
};

router.use('/campaigns', requireCampaignAccess);

router.get('/campaigns', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try {
    const { page, limit, skip } = pageFromQuery(req.query);
    const status = String(req.query.status || '').trim();
    const search = String(req.query.search || '').trim().slice(0, 100);
    const query = {
      tenantId: req.tenantId,
      ...(status ? { status } : {}),
      ...(search ? { $or: [{ name: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }, { id: search }] } : {})
    };
    const [items, total] = await Promise.all([
      adapter.findMany(COLLECTIONS.campaigns, {
        query,
        projection: { _id: 0, items: 0, values: 0 },
        sort: { createdAt: -1 }, skip, limit
      }),
      adapter.countDocuments(COLLECTIONS.campaigns, query)
    ]);
    res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ code: 'campaign_list_failed', message: 'Falha ao listar campanhas', correlationId: req.correlationId });
  }
});

router.post('/campaigns', authorize(writeRoles, { permission: 'campanhas.gerenciar' }), async (req, res) => {
  if (Array.isArray(req.body?.contactIds) && req.body.contactIds.length > getOutreachCampaignMaxContacts()) {
    return res.status(400).json({
      code: 'campaign_contact_limit_exceeded',
      message: 'A campanha excede o limite permitido de contatos.',
      correlationId: req.correlationId
    });
  }
  const parsed = campaignSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ code: 'invalid_campaign', message: 'Campanha invalida', details: parsed.error.flatten(), correlationId: req.correlationId });
  try {
    const campaign = await createOutreachCampaign({ tenantId: req.tenantId, ...parsed.data, actor: req.user });
    if (!parsed.data.cadenceId && !parsed.data.scheduledAt) {
      const job = isBullMqEnabled() ? await enqueueCampaignProcessing({ campaignId: campaign.id, reason: 'api_created' }) : null;
      if (!job) wakeOutreachCampaignWorker();
    }
    await createLog('OUTREACH_CAMPAIGN_CREATE', { tenantId: req.tenantId, campaignId: campaign.id, name: campaign.name }, req.user.id);
    res.status(201).json(campaign);
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ code: error?.code || 'campaign_create_failed', message: error.message || 'Falha ao criar campanha', correlationId: req.correlationId });
  }
});

router.get('/campaigns/:id', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const campaign = await getOutreachCampaignById({ tenantId: req.tenantId, campaignId: req.params.id });
  if (!campaign) return res.status(404).json({ code: 'campaign_not_found', message: 'Campanha nao encontrada', correlationId: req.correlationId });
  res.json(campaign);
});

router.get('/campaigns/:id/items', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const { page, limit, skip } = pageFromQuery(req.query, { defaultLimit: 50, maxLimit: 200 });
  const status = String(req.query.status || '').trim();
  const query = { tenantId: req.tenantId, campaignId: req.params.id, ...(status ? { status } : {}) };
  const [items, total] = await Promise.all([
    adapter.findMany(COLLECTIONS.campaignItems, { query, projection: { _id: 0 }, sort: { sortIndex: 1, createdAt: 1 }, skip, limit }),
    adapter.countDocuments(COLLECTIONS.campaignItems, query)
  ]);
  res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

router.get('/campaigns/:id/metrics', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const metrics = await calculateCampaignMetrics({ tenantId: req.tenantId, campaignId: req.params.id });
  if (!metrics) return res.status(404).json({ code: 'campaign_not_found', message: 'Campanha nao encontrada', correlationId: req.correlationId });
  res.json(metrics);
});

const updateCampaignState = (action) => async (req, res) => {
  const campaign = await adapter.findOne(COLLECTIONS.campaigns, { tenantId: req.tenantId, id: req.params.id });
  if (!campaign) return res.status(404).json({ code: 'campaign_not_found', message: 'Campanha nao encontrada', correlationId: req.correlationId });
  if (action === 'resume' && await isTenantBillingPaused(req.tenantId)) {
    return res.status(402).json({ code: 'billing_paused', message: 'Envios ativos pausados por pendência de pagamento. A campanha volta sozinha quando a conta for regularizada.', correlationId: req.correlationId });
  }
  const statusByAction = { pause: 'paused', resume: campaign.cadenceId ? 'scheduled' : 'pending', cancel: 'cancelled' };
  const status = statusByAction[action];
  const extra = {};
  if (action === 'resume' && campaign.qualityPause) {
    // Pausada pela qualidade: so volta com a pessoa ciente do motivo. Os sinais
    // confirmados ficam em qualityAck e nao pausam de novo; um sinal novo pausa.
    const ack = new Set(campaign.qualityAck || []);
    const naoVistos = (await pendingQualitySignalsForResume(campaign)).filter((signal) => !ack.has(signal.key));
    if (naoVistos.length && req.body?.acknowledgeQuality !== true) {
      return res.status(409).json({
        code: 'quality_ack_required',
        message: 'A campanha foi pausada por queda de qualidade. Confirme que revisou antes de retomar.',
        reasons: naoVistos.map(({ key, title, message }) => ({ key, title, message })),
        correlationId: req.correlationId
      });
    }
    Object.assign(extra, {
      qualityAck: [...ack, ...naoVistos.map((signal) => signal.key)],
      qualityPause: null,
      qualityResumedAt: nowIso(),
      qualityResumedBy: req.user?.id || null
    });
  }
  await adapter.updateOne(COLLECTIONS.campaigns, { id: campaign.id }, { $set: { status, updatedAt: nowIso(), ...extra, ...(action === 'cancel' ? { finishedAt: nowIso() } : {}) } });
  if (action === 'pause') {
    const executions = await adapter.findMany(COLLECTIONS.cadenceExecutions, { query: { tenantId: req.tenantId, campaignId: campaign.id, status: { $in: ['scheduled', 'waiting', 'running'] } }, limit: 100000 });
    for (const item of executions) await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: item.id }, { $set: { status: 'paused', updatedAt: nowIso() } });
  }
  if (action === 'resume') {
    const executions = await adapter.findMany(COLLECTIONS.cadenceExecutions, { query: { tenantId: req.tenantId, campaignId: campaign.id, status: 'paused' }, limit: 100000 });
    for (const item of executions) await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: item.id }, { $set: { status: 'waiting', nextExecutionAt: item.nextExecutionAt || nowIso(), updatedAt: nowIso() } });
    if (!campaign.cadenceId) wakeOutreachCampaignWorker();
  }
  if (action === 'cancel') {
    const pendingItems = await adapter.findMany(COLLECTIONS.campaignItems, { query: { tenantId: req.tenantId, campaignId: campaign.id, status: { $in: ['pending', 'scheduled', 'sending'] } }, limit: 100000 });
    for (const item of pendingItems) await adapter.updateOne(COLLECTIONS.campaignItems, { id: item.id }, { $set: { status: 'cancelled', updatedAt: nowIso() } });
    const executions = await adapter.findMany(COLLECTIONS.cadenceExecutions, { query: { tenantId: req.tenantId, campaignId: campaign.id, status: { $in: ['scheduled', 'waiting', 'running', 'paused'] } }, limit: 100000 });
    for (const item of executions) await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: item.id }, { $set: { status: 'cancelled', nextExecutionAt: null, updatedAt: nowIso() } });
  }
  await createLog(`OUTREACH_CAMPAIGN_${action.toUpperCase()}`, { tenantId: req.tenantId, campaignId: campaign.id, ...(extra.qualityAck ? { qualityAck: extra.qualityAck } : {}) }, req.user.id);
  res.json({ ...campaign, ...extra, status, updatedAt: nowIso() });
};

router.post('/campaigns/:id/pause', authorize(writeRoles, { permission: 'campanhas.gerenciar' }), updateCampaignState('pause'));
router.post('/campaigns/:id/resume', authorize(writeRoles, { permission: 'campanhas.gerenciar' }), updateCampaignState('resume'));
router.post('/campaigns/:id/cancel', authorize(writeRoles, { permission: 'campanhas.gerenciar' }), updateCampaignState('cancel'));

router.post('/campaigns/:id/reprocess-failures', authorize(writeRoles, { permission: 'campanhas.gerenciar' }), async (req, res) => {
  const failed = await adapter.findMany(COLLECTIONS.campaignItems, { query: { tenantId: req.tenantId, campaignId: req.params.id, status: 'failed' }, limit: 100000 });
  for (const item of failed) {
    await adapter.updateOne(COLLECTIONS.campaignItems, { id: item.id }, { $set: { status: 'pending', error: null, failureCode: null, failureReason: null, updatedAt: nowIso() } });
  }
  await adapter.updateOne(COLLECTIONS.campaigns, { tenantId: req.tenantId, id: req.params.id }, { $set: { status: 'pending', finishedAt: null, updatedAt: nowIso() } });
  if (failed.length) wakeOutreachCampaignWorker();
  await createLog('OUTREACH_CAMPAIGN_REPROCESS', { tenantId: req.tenantId, campaignId: req.params.id, count: failed.length }, req.user.id);
  res.json({ ok: true, requeued: failed.length });
});

router.get('/suppressions', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const { page, limit } = pageFromQuery(req.query);
  res.json(await listSuppressions({ tenantId: req.tenantId, page, limit }));
});

router.post('/suppressions', authorize(writeRoles, { permission: 'campanhas.gerenciar' }), async (req, res) => {
  const parsed = z.object({ contactId: z.string().nullable().optional(), channel: z.string().default('whatsapp'), identifier: z.string().min(5), reason: z.string().default('manual'), global: z.boolean().optional() }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ code: 'invalid_suppression', message: 'Supressao invalida', details: parsed.error.flatten(), correlationId: req.correlationId });
  const item = await suppressContact({ tenantId: req.tenantId, ...parsed.data, source: 'manual', createdBy: req.user.id });
  await createLog('CONTACT_SUPPRESSED', { tenantId: req.tenantId, suppressionId: item.id, contactId: item.contactId, reason: item.reason }, req.user.id);
  res.status(201).json(item);
});

router.delete('/suppressions/:id', authorize(writeRoles, { permission: 'campanhas.gerenciar' }), async (req, res) => {
  const item = await removeSuppression({ tenantId: req.tenantId, suppressionId: req.params.id });
  if (!item) return res.status(404).json({ code: 'suppression_not_found', message: 'Supressao nao encontrada', correlationId: req.correlationId });
  await createLog('CONTACT_SUPPRESSION_REMOVED', { tenantId: req.tenantId, suppressionId: item.id }, req.user.id);
  res.json({ ok: true, id: item.id });
});

export default router;
