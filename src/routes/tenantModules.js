import express from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import { createLog } from '../services/logs.js';
import { BRAND_COLOR_PATTERN } from '../services/branding.js';
import { saveTenantSettings } from '../services/tenantSettings.js';
import {
  getTenantModuleOverview, getTenantModuleSettings, getTenantPerformance, getTenantUsage,
  listTenantAudit, listTenantCampaigns, listTenantInbox, listTenantIncidents,
  paginationFromQuery, updateTenantModuleSettings
} from '../services/tenantModules.js';
import { updateTenantIncidentStatus } from '../services/tenantActivity.js';
import {
  createLibraryItem, deleteLibraryItem, getLibraryItem, listLibraryItems,
  updateLibraryItem, validateStoredFlow
} from '../services/automationLibrary.js';

const router = express.Router();
const readRoles = ['ADMIN', 'MANAGER'];
const writeRoles = ['ADMIN'];

const optionalEmail = z.union([z.string().email(), z.literal('')]).optional();
// Logo e icone viram src/href no navegador de todo usuario do tenant: so https.
const optionalHttpsUrl = z.union([
  z.string().trim().url().refine((value) => value.startsWith('https://'), 'Use um endereco https://'),
  z.literal('')
]).optional();
const settingsSchemas = {
  identity: z.object({
    organizationName: z.string().trim().max(120).optional(),
    productName: z.string().trim().max(60).optional(),
    logoUrl: optionalHttpsUrl,
    faviconUrl: optionalHttpsUrl,
    loginImageUrl: optionalHttpsUrl,
    primaryColor: z.union([z.string().regex(BRAND_COLOR_PATTERN, 'Cor no formato #RRGGBB'), z.literal('')]).optional(),
    supportEmail: optionalEmail,
    supportWhatsapp: z.union([z.string().trim().regex(/^\+?[\d\s()-]{10,20}$/, 'WhatsApp com DDI e DDD'), z.literal('')]).optional(),
    locale: z.string().trim().max(20).optional(),
    timezone: z.string().trim().max(80).optional(),
    welcomeMessage: z.string().max(2000).optional()
  }).strict(),
  rules: z.object({
    restartCommand: z.string().trim().max(64).optional(),
    humanCommand: z.string().trim().max(64).optional(),
    closeCommand: z.string().trim().max(64).optional(),
    inactivityMinutes: z.number().int().min(1).max(43200).optional(),
    closeMessage: z.string().max(2000).optional(),
    silentClose: z.boolean().optional(),
    // Quando true, ao assumir um atendimento o cliente NAO recebe o aviso
    // "O agente X assumiu o atendimento." (o registro interno e mantido).
    silentPickup: z.boolean().optional()
  }).strict(),
  // Nome de cada nivel na tela da empresa (A1-A9, B1-B9, C1-C9).
  cargos: z.record(z.string().regex(/^[ABC][1-9]$/), z.string().trim().max(40)),
  retention: z.object({
    chatRetentionDays: z.number().int().min(0).max(3650).optional(),
    logRetentionDays: z.number().int().min(0).max(3650).optional(),
    mediaRetentionDays: z.number().int().min(0).max(3650).optional(),
    deleteOnRequest: z.boolean().optional()
  }).strict()
};

const libraryPayloadSchema = z.object({
  nodes: z.array(z.unknown()).max(500).optional(),
  edges: z.array(z.unknown()).max(1000).optional(),
  visualBlocks: z.array(z.unknown()).max(200).optional(),
  template: z.unknown().optional()
}).strict().superRefine((value, ctx) => {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > 1024 * 1024) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Payload excede 1 MB' });
});

const libraryCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  type: z.enum(['flow', 'block', 'template']),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  payload: libraryPayloadSchema
}).strict();

const libraryUpdateSchema = libraryCreateSchema.omit({ type: true }).partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'Informe ao menos um campo para atualizar' }
);

router.use(authenticate, requireTenant);
router.use((req, res, next) => {
  if (!req.tenantId) return res.status(400).json({ error: 'TenantId obrigatorio para este modulo' });
  next();
});

router.get('/overview', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try { res.json(await getTenantModuleOverview(req.tenantId)); }
  catch (error) { res.status(500).json({ error: 'Falha ao carregar resumo dos modulos' }); }
});

router.get('/inbox', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try { res.json(await listTenantInbox(req.tenantId, req.query)); }
  catch (error) { res.status(500).json({ error: 'Falha ao carregar caixa de entrada' }); }
});

router.get('/campaigns', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try { res.json(await listTenantCampaigns(req.tenantId, req.query)); }
  catch (error) { res.status(500).json({ error: 'Falha ao carregar campanhas' }); }
});

router.get('/incidents', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try { res.json(await listTenantIncidents(req.tenantId, req.query)); }
  catch (error) { res.status(500).json({ error: 'Falha ao carregar ocorrencias' }); }
});

router.patch('/incidents/:incidentId', authorize(writeRoles, { permission: 'config.empresa' }), async (req, res) => {
  const parsed = z.object({ status: z.enum(['open', 'resolved', 'ignored']) }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Status de ocorrencia invalido' });
  try {
    const incident = await updateTenantIncidentStatus({
      tenantId: req.tenantId,
      incidentId: req.params.incidentId,
      status: parsed.data.status,
      userId: req.user.id
    });
    if (!incident) return res.status(404).json({ error: 'Ocorrencia nao encontrada' });
    await createLog('INCIDENT_UPDATE', {
      tenantId: req.tenantId,
      id: incident.id,
      status: parsed.data.status,
      changedFields: ['status']
    }, req.user.id);
    res.json(incident);
  } catch (error) {
    res.status(500).json({ error: 'Falha ao atualizar ocorrencia' });
  }
});

router.get('/audit', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try { res.json(await listTenantAudit(req.tenantId, req.query)); }
  catch (error) { res.status(500).json({ error: 'Falha ao carregar auditoria' }); }
});

router.get('/usage', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try { res.json(await getTenantUsage(req.tenantId)); }
  catch (error) { res.status(500).json({ error: 'Falha ao carregar consumo' }); }
});

router.get('/performance', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try { res.json(await getTenantPerformance(req.tenantId, req.query)); }
  catch (error) { res.status(500).json({ error: 'Falha ao carregar desempenho da equipe' }); }
});

router.get('/library', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try {
    const pagination = paginationFromQuery(req.query);
    const type = String(req.query.type || '').trim();
    if (type && !['flow', 'block', 'template'].includes(type)) return res.status(400).json({ error: 'Tipo de item invalido' });
    res.json(await listLibraryItems(req.tenantId, pagination, { type }));
  } catch (error) {
    res.status(500).json({ error: 'Falha ao carregar biblioteca' });
  }
});

router.get('/library/:itemId', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try {
    const item = await getLibraryItem(req.tenantId, req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Item da biblioteca nao encontrado' });
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: 'Falha ao carregar item da biblioteca' });
  }
});

router.post('/library', authorize(writeRoles, { permission: 'config.empresa' }), async (req, res) => {
  const parsed = libraryCreateSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Item invalido', details: parsed.error.flatten() });
  try {
    const item = await createLibraryItem(req.tenantId, parsed.data, req.user.id);
    await createLog('LIBRARY_CREATE', { tenantId: req.tenantId, id: item.id, name: item.name }, req.user.id);
    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ error: 'Falha ao criar item da biblioteca' });
  }
});

router.patch('/library/:itemId', authorize(writeRoles, { permission: 'config.empresa' }), async (req, res) => {
  const parsed = libraryUpdateSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Atualizacao invalida', details: parsed.error.flatten() });
  try {
    const item = await updateLibraryItem(req.tenantId, req.params.itemId, parsed.data, req.user.id);
    if (!item) return res.status(404).json({ error: 'Item da biblioteca nao encontrado' });
    await createLog('LIBRARY_UPDATE', { tenantId: req.tenantId, id: item.id, name: item.name, changedFields: Object.keys(parsed.data) }, req.user.id);
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: 'Falha ao atualizar item da biblioteca' });
  }
});

router.delete('/library/:itemId', authorize(writeRoles, { permission: 'config.empresa' }), async (req, res) => {
  try {
    const item = await deleteLibraryItem(req.tenantId, req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Item da biblioteca nao encontrado' });
    await createLog('LIBRARY_DELETE', { tenantId: req.tenantId, id: item.id, name: item.name }, req.user.id);
    res.json({ ok: true, id: item.id });
  } catch (error) {
    res.status(500).json({ error: 'Falha ao remover item da biblioteca' });
  }
});

router.get('/tests/flows/:flowId', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const source = String(req.query.source || 'published').trim();
  if (!['published', 'draft'].includes(source)) return res.status(400).json({ error: 'Source deve ser published ou draft' });
  try {
    const report = await validateStoredFlow(req.tenantId, req.params.flowId, source);
    if (!report) return res.status(404).json({ error: 'Fluxo nao encontrado' });
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: 'Falha ao validar estrutura do fluxo' });
  }
});

router.get('/settings/:moduleKey', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  const schema = settingsSchemas[req.params.moduleKey];
  if (!schema) return res.status(404).json({ error: 'Modulo de configuracao nao encontrado' });
  try {
    const settings = await getTenantModuleSettings(req.tenantId, req.params.moduleKey);
    res.json({ module: req.params.moduleKey, settings });
  } catch (error) {
    res.status(500).json({ error: 'Falha ao carregar configuracao' });
  }
});

router.patch('/settings/:moduleKey', authorize(writeRoles, { permission: 'config.empresa' }), async (req, res) => {
  const schema = settingsSchemas[req.params.moduleKey];
  if (!schema) return res.status(404).json({ error: 'Modulo de configuracao nao encontrado' });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Configuracao invalida', details: parsed.error.flatten() });
  try {
    const settings = await updateTenantModuleSettings(req.tenantId, req.params.moduleKey, parsed.data, req.user.id);
    if (req.params.moduleKey === 'rules') {
      await saveTenantSettings(req.tenantId, {
        ...(parsed.data.inactivityMinutes !== undefined ? { inactivityMaxHours: parsed.data.inactivityMinutes / 60 } : {}),
        ...(parsed.data.closeMessage !== undefined ? { inactivityMessage: parsed.data.closeMessage } : {}),
        ...(parsed.data.silentPickup !== undefined ? { silentPickup: parsed.data.silentPickup } : {})
      });
    }
    if (req.params.moduleKey === 'retention') {
      await saveTenantSettings(req.tenantId, {
        chatRetentionDays: parsed.data.chatRetentionDays,
        logRetentionDays: parsed.data.logRetentionDays,
        mediaRetentionDays: parsed.data.mediaRetentionDays
      });
    }
    await createLog('TENANT_MODULE_SETTINGS_UPDATE', {
      tenantId: req.tenantId,
      module: req.params.moduleKey,
      changedFields: Object.keys(parsed.data)
    }, req.user.id);
    res.json({ module: req.params.moduleKey, settings });
  } catch (error) {
    res.status(500).json({ error: 'Falha ao salvar configuracao' });
  }
});

export default router;
