import express from 'express';
import { z } from 'zod';
import adapter from '../../db/DatabaseAdapter.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import { createLog } from '../services/logs.js';
import { activatePromptVersion, reviewClassification } from '../services/aiClassification.js';
import { COLLECTIONS, INTENTS, NEXT_ACTIONS, SENTIMENTS, createDomainId, nowIso, pageFromQuery } from '../services/outreachDomain.js';
import { enqueueLeadClassification } from '../queues/classificationQueue.js';

const router = express.Router();
const readRoles = ['ADMIN', 'MANAGER'];
const reviewRoles = ['ADMIN', 'MANAGER'];
const controllerRoles = ['SUPER_ADMIN'];

router.use(authenticate, requireTenant);

router.get('/', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const { page, limit, skip } = pageFromQuery(req.query);
  const query = { tenantId: req.tenantId };
  const reviewStatus = String(req.query.reviewStatus || '').trim();
  const intent = String(req.query.intent || '').trim();
  if (reviewStatus) query.reviewStatus = reviewStatus;
  if (intent) query.intent = intent;
  const [items, total] = await Promise.all([
    adapter.findMany(COLLECTIONS.classifications, {
      query,
      projection: { _id: 0, rawProviderResponse: 0 },
      sort: { createdAt: -1 }, skip, limit
    }),
    adapter.countDocuments(COLLECTIONS.classifications, query)
  ]);
  res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

router.get('/:id', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const item = await adapter.findOne(COLLECTIONS.classifications, { tenantId: req.tenantId, id: req.params.id }, { projection: { _id: 0, rawProviderResponse: 0 } });
  if (!item) return res.status(404).json({ code: 'classification_not_found', message: 'Classificacao nao encontrada', correlationId: req.correlationId });
  res.json(item);
});

router.post('/:id/review', authorize(reviewRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const parsed = z.object({
    intent: z.enum(INTENTS).optional(), sentiment: z.enum(SENTIMENTS).optional(),
    nextAction: z.enum(NEXT_ACTIONS).optional(), reason: z.string().max(1000).optional(),
    suggestedReply: z.string().max(4000).nullable().optional()
  }).strict().refine((value) => Object.keys(value).length > 0).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ code: 'invalid_review', message: 'Revisao invalida', details: parsed.error.flatten(), correlationId: req.correlationId });
  const item = await reviewClassification({ tenantId: req.tenantId, classificationId: req.params.id, reviewer: req.user, patch: parsed.data });
  if (!item) return res.status(404).json({ code: 'classification_not_found', message: 'Classificacao nao encontrada', correlationId: req.correlationId });
  await createLog('CLASSIFICATION_REVIEW', { tenantId: req.tenantId, classificationId: item.id, changedFields: Object.keys(parsed.data) }, req.user.id);
  res.json(item);
});

router.post('/:id/reprocess', authorize(reviewRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const item = await adapter.findOne(COLLECTIONS.classifications, { tenantId: req.tenantId, id: req.params.id });
  if (!item) return res.status(404).json({ code: 'classification_not_found', message: 'Classificacao nao encontrada', correlationId: req.correlationId });
  const queued = await enqueueLeadClassification({
    tenantId: req.tenantId,
    messageId: item.messageId,
    classificationId: item.id,
    force: true
  });
  await createLog('CLASSIFICATION_REPROCESS', { tenantId: req.tenantId, classificationId: item.id, messageId: item.messageId }, req.user.id);
  res.status(202).json({
    ok: true,
    queued: true,
    messageId: item.messageId,
    classificationId: item.id,
    reprocessRequestId: queued?.data?.reprocessRequestId || queued?.reprocessRequestId || null
  });
});

router.get('/prompts/versions', authorize(controllerRoles), async (req, res) => {
  const items = await adapter.findMany('aiPromptVersions', { query: { $or: [{ tenantId: req.tenantId }, { tenantId: null }] }, projection: { _id: 0 }, sort: { createdAt: -1 }, limit: 100 });
  res.json({ items });
});

router.post('/prompts/versions', authorize(controllerRoles), async (req, res) => {
  const parsed = z.object({ prompt: z.string().min(20).max(20000), version: z.string().min(1).max(80), tenantScoped: z.boolean().default(true), activate: z.boolean().default(false) }).strict().safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ code: 'invalid_prompt', message: 'Prompt invalido', details: parsed.error.flatten(), correlationId: req.correlationId });
  const now = nowIso();
  const prompt = { id: createDomainId('ai_prompt'), tenantId: parsed.data.tenantScoped ? req.tenantId : null, prompt: parsed.data.prompt, version: parsed.data.version, active: false, createdBy: req.user.id, createdAt: now, updatedAt: now };
  await adapter.insertOne('aiPromptVersions', prompt);
  if (parsed.data.activate) await activatePromptVersion({ tenantId: prompt.tenantId, promptId: prompt.id, actorId: req.user.id });
  await createLog('AI_PROMPT_CREATE', { tenantId: prompt.tenantId, promptId: prompt.id, version: prompt.version }, req.user.id);
  res.status(201).json({ ...prompt, active: parsed.data.activate });
});

router.post('/prompts/versions/:id/activate', authorize(controllerRoles), async (req, res) => {
  const prompt = await activatePromptVersion({ tenantId: req.tenantId, promptId: req.params.id, actorId: req.user.id })
    || await activatePromptVersion({ tenantId: null, promptId: req.params.id, actorId: req.user.id });
  if (!prompt) return res.status(404).json({ code: 'prompt_not_found', message: 'Prompt nao encontrado', correlationId: req.correlationId });
  await createLog('AI_PROMPT_ACTIVATE', { tenantId: prompt.tenantId, promptId: prompt.id, version: prompt.version }, req.user.id);
  res.json(prompt);
});

export default router;
