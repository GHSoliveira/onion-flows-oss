import express from 'express';
import { z } from 'zod';
import adapter from '../../db/DatabaseAdapter.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import {
  ATTENDANCE_PRIORITIES,
  ATTENDANCE_ROUTING_ACTIONS,
  ATTENDANCE_ROUTING_TRIGGERS,
  getAttendanceRoutingProfile,
  routeClassifiedReplyToAttendance
} from '../services/attendanceRouting.js';
import { createLog } from '../services/logs.js';
import { COLLECTIONS, INTENTS, NEXT_ACTIONS, SENTIMENTS, nowIso } from '../services/outreachDomain.js';

const router = express.Router();
const controllerRoles = ['ADMIN', 'MANAGER'];

const conditionSchema = z.object({
  optOutDetected: z.boolean().optional(),
  requiresHumanReview: z.boolean().optional(),
  intentIn: z.array(z.enum(INTENTS)).max(100).optional(),
  sentimentIn: z.array(z.enum(SENTIMENTS)).max(20).optional(),
  nextActionIn: z.array(z.enum(NEXT_ACTIONS)).max(50).optional(),
  nextActionNotIn: z.array(z.enum(NEXT_ACTIONS)).max(50).optional(),
  confidenceLt: z.number().min(0).max(1).optional(),
  confidenceGte: z.number().min(0).max(1).optional(),
  sourceIn: z.array(z.enum(ATTENDANCE_ROUTING_TRIGGERS)).max(20).optional(),
  any: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
  all: z.array(z.record(z.string(), z.unknown())).max(20).optional()
}).strict();

const actionSchema = z.object({
  type: z.enum(ATTENDANCE_ROUTING_ACTIONS),
  queueId: z.string().trim().min(1).max(160).nullable().optional(),
  queueRef: z.enum(['default', 'review']).optional(),
  priority: z.enum(ATTENDANCE_PRIORITIES).default('normal'),
  stopAutomation: z.boolean().default(true),
  createTask: z.boolean().optional(),
  closeTask: z.boolean().optional()
}).strict();

const profileSchema = z.object({
  name: z.string().trim().min(1).max(160),
  trigger: z.enum(ATTENDANCE_ROUTING_TRIGGERS).default('campaign_reply'),
  active: z.boolean().default(true),
  defaultQueueId: z.string().trim().min(1).max(160).nullable().default(null),
  reviewQueueId: z.string().trim().min(1).max(160).nullable().default(null),
  waitingWarningMinutes: z.number().int().min(1).max(1440).default(5),
  rules: z.array(z.object({
    id: z.string().trim().min(1).max(160),
    order: z.number().int().min(0).max(100000),
    enabled: z.boolean().default(true),
    conditions: conditionSchema,
    action: actionSchema
  }).strict()).min(1).max(100)
}).strict();

router.use(authenticate, requireTenant);

router.get('/profile', authorize(controllerRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const trigger = String(req.query.trigger || 'campaign_reply');
  if (!ATTENDANCE_ROUTING_TRIGGERS.includes(trigger)) {
    return res.status(400).json({ code: 'invalid_trigger', message: 'Gatilho de roteamento invalido' });
  }
  const profile = await getAttendanceRoutingProfile({ tenantId: req.tenantId, trigger });
  res.json(profile);
});

router.put('/profile', authorize(controllerRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const parsed = profileSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ code: 'invalid_routing_profile', message: 'Perfil de roteamento invalido', details: parsed.error.flatten() });
  }
  const queueIds = [parsed.data.defaultQueueId, parsed.data.reviewQueueId, ...parsed.data.rules.map((rule) => rule.action.queueId)]
    .filter(Boolean);
  if (queueIds.length) {
    const queues = await adapter.findMany('queues', { query: { tenantId: req.tenantId, id: { $in: [...new Set(queueIds)] } }, limit: 500 });
    if (queues.length !== new Set(queueIds).size) {
      return res.status(400).json({ code: 'invalid_queue_binding', message: 'Uma ou mais filas nao pertencem ao tenant ou nao existem' });
    }
  }

  const current = await getAttendanceRoutingProfile({ tenantId: req.tenantId, trigger: parsed.data.trigger, createDefault: false });
  const now = nowIso();
  const profile = {
    ...(current || {}),
    ...parsed.data,
    id: current?.id || `routing_profile_${req.tenantId}_${parsed.data.trigger}`,
    tenantId: req.tenantId,
    version: Number(current?.version || 0) + 1,
    createdBy: current?.createdBy || req.user.id,
    createdAt: current?.createdAt || now,
    updatedBy: req.user.id,
    updatedAt: now
  };
  await adapter.updateOne(COLLECTIONS.attendanceRoutingProfiles, { tenantId: req.tenantId, id: profile.id }, { $set: profile }, { upsert: true });
  await createLog('ATTENDANCE_ROUTING_PROFILE_UPDATE', { tenantId: req.tenantId, profileId: profile.id, version: profile.version }, req.user.id);
  res.json(profile);
});

router.get('/decisions', authorize(controllerRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const query = { tenantId: req.tenantId };
  if (req.query.status) query.status = String(req.query.status);
  const [items, total] = await Promise.all([
    adapter.findMany(COLLECTIONS.attendanceRoutingDecisions, {
      query, projection: { _id: 0 }, sort: { createdAt: -1 }, skip: (page - 1) * limit, limit
    }),
    adapter.countDocuments(COLLECTIONS.attendanceRoutingDecisions, query)
  ]);
  res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

router.post('/decisions/:id/retry', authorize(controllerRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const decision = await adapter.findOne(COLLECTIONS.attendanceRoutingDecisions, { tenantId: req.tenantId, id: req.params.id });
  if (!decision) return res.status(404).json({ code: 'routing_decision_not_found', message: 'Decisao de roteamento nao encontrada' });
  const classification = await adapter.findOne(COLLECTIONS.classifications, { tenantId: req.tenantId, id: decision.classificationId });
  if (!classification) return res.status(404).json({ code: 'classification_not_found', message: 'Classificacao nao encontrada' });
  const result = await routeClassifiedReplyToAttendance({ classification, trigger: decision.trigger || 'campaign_reply', force: true });
  res.json(result);
});

export default router;
