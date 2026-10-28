import express from 'express';
import { z } from 'zod';
import adapter from '../../db/DatabaseAdapter.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import { createLog } from '../services/logs.js';
import { createCadence, updateCadence } from '../services/cadenceEngine.js';
import { COLLECTIONS, pageFromQuery, nowIso } from '../services/outreachDomain.js';
import { envFlag } from '../utils/env.js';

const router = express.Router();
const readRoles = ['ADMIN', 'MANAGER'];
const writeRoles = ['ADMIN'];
const stepSchema = z.object({
  delayMinutes: z.number().int().min(0).max(525600),
  action: z.enum(['send_template', 'close_cadence']).default('send_template'),
  templateId: z.string().nullable().optional(),
  senderPhoneNumberId: z.string().nullable().optional(),
  values: z.record(z.string(), z.unknown()).optional(),
  conditions: z.unknown().nullable().optional(),
  skipIfReplied: z.boolean().optional(), skipIfRead: z.boolean().optional(),
  nextStepOnPositive: z.number().int().nullable().optional(), nextStepOnNegative: z.number().int().nullable().optional(), nextStepOnNoResponse: z.number().int().nullable().optional()
}).strict();
const schema = z.object({
  name: z.string().trim().min(1).max(160), description: z.string().max(1000).optional(),
  status: z.enum(['draft', 'active', 'paused']).optional(), steps: z.array(stepSchema).min(1).max(50),
  timezone: z.string().max(80).optional(), allowedWeekdays: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  allowedStartTime: z.string().regex(/^\d{2}:\d{2}$/).optional(), allowedEndTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  stopOnReply: z.boolean().optional(), stopOnPositive: z.boolean().optional(), stopOnNegative: z.boolean().optional(), stopOnOptOut: z.boolean().optional()
}).strict();

router.use(authenticate, requireTenant);
router.use((req, res, next) => {
  if (req.user.role !== 'MANAGER' || envFlag('CLIENT_CAMPAIGN_ACCESS_ENABLED', false)) return next();
  return res.status(403).json({
    code: 'campaign_access_disabled',
    message: 'O acesso do cliente a cadencias nao esta habilitado',
    correlationId: req.correlationId
  });
});
router.get('/', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const { page, limit, skip } = pageFromQuery(req.query);
  const query = { tenantId: req.tenantId };
  const [items, total] = await Promise.all([
    adapter.findMany(COLLECTIONS.cadences, { query, projection: { _id: 0 }, sort: { updatedAt: -1 }, skip, limit }),
    adapter.countDocuments(COLLECTIONS.cadences, query)
  ]);
  res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});
router.post('/', authorize(writeRoles, { permission: 'campanhas.gerenciar' }), async (req, res) => {
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ code: 'invalid_cadence', message: 'Cadencia invalida', details: parsed.error.flatten(), correlationId: req.correlationId });
  const cadence = await createCadence({ tenantId: req.tenantId, data: parsed.data, actor: req.user });
  await createLog('CADENCE_CREATE', { tenantId: req.tenantId, cadenceId: cadence.id, name: cadence.name }, req.user.id);
  res.status(201).json(cadence);
});
router.patch('/:id', authorize(writeRoles, { permission: 'campanhas.gerenciar' }), async (req, res) => {
  const parsed = schema.partial().safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ code: 'invalid_cadence', message: 'Cadencia invalida', details: parsed.error.flatten(), correlationId: req.correlationId });
  const cadence = await updateCadence({ tenantId: req.tenantId, cadenceId: req.params.id, patch: parsed.data, actor: req.user });
  if (!cadence) return res.status(404).json({ code: 'cadence_not_found', message: 'Cadencia nao encontrada', correlationId: req.correlationId });
  await createLog('CADENCE_UPDATE', { tenantId: req.tenantId, cadenceId: cadence.id, changedFields: Object.keys(parsed.data) }, req.user.id);
  res.json(cadence);
});
const changeStatus = (status) => async (req, res) => {
  const cadence = await adapter.findOne(COLLECTIONS.cadences, { tenantId: req.tenantId, id: req.params.id });
  if (!cadence) return res.status(404).json({ code: 'cadence_not_found', message: 'Cadencia nao encontrada', correlationId: req.correlationId });
  await adapter.updateOne(COLLECTIONS.cadences, { id: cadence.id }, { $set: { status, updatedAt: nowIso(), updatedBy: req.user.id } });
  await createLog(`CADENCE_${status.toUpperCase()}`, { tenantId: req.tenantId, cadenceId: cadence.id }, req.user.id);
  res.json({ ...cadence, status, updatedAt: nowIso() });
};
router.post('/:id/activate', authorize(writeRoles, { permission: 'campanhas.gerenciar' }), changeStatus('active'));
router.post('/:id/pause', authorize(writeRoles, { permission: 'campanhas.gerenciar' }), changeStatus('paused'));
router.post('/:id/duplicate', authorize(writeRoles, { permission: 'campanhas.gerenciar' }), async (req, res) => {
  const source = await adapter.findOne(COLLECTIONS.cadences, { tenantId: req.tenantId, id: req.params.id });
  if (!source) return res.status(404).json({ code: 'cadence_not_found', message: 'Cadencia nao encontrada', correlationId: req.correlationId });
  const cadence = await createCadence({
    tenantId: req.tenantId,
    data: {
      name: String(req.body?.name || `${source.name} - copia`).slice(0, 160),
      description: source.description || '',
      status: 'draft',
      steps: source.steps || [],
      timezone: source.timezone,
      allowedWeekdays: source.allowedWeekdays,
      allowedStartTime: source.allowedStartTime,
      allowedEndTime: source.allowedEndTime,
      stopOnReply: source.stopOnReply,
      stopOnPositive: source.stopOnPositive,
      stopOnNegative: source.stopOnNegative,
      stopOnOptOut: source.stopOnOptOut
    },
    actor: req.user
  });
  await createLog('CADENCE_DUPLICATE', { tenantId: req.tenantId, cadenceId: cadence.id, sourceCadenceId: source.id }, req.user.id);
  res.status(201).json(cadence);
});
export default router;
