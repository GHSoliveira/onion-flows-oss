import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { destructiveLimiter } from '../middleware/rateLimits.js';
import { noteDestructiveAction } from '../services/deleteBurstTracker.js';
import { getTenantAnalytics } from '../services/analytics.js';
import { getTenantSettings, saveTenantSettings } from '../services/tenantSettings.js';
import { normalizeTenantEnvironment, setTenantEnvironment, TENANT_ENVIRONMENTS } from '../services/tenantEnvironment.js';
import { authorize, requireSuperAdminPermission } from '../middleware/authorization.js';
import adapter from '../../db/DatabaseAdapter.js';
import { getOnlineUserIds } from '../services/userStatus.js';
import { createLog } from '../services/logs.js';
import { invalidateTenantCache } from '../services/tenantLimits.js';
import { migrateTenantSecretVars, sanitizeChatCollectionForAgent } from '../services/chatSecurity.js';
import { buildChatSummaryCollection } from '../services/chatSummaries.js';
import { applyBillingBlock, isBillingBlocked, runAutoBlockScan } from '../services/billingGuard.js';
import { generateId } from '../utils/helpers.js';

const router = express.Router();
const TENANT_MEMBER_READ_ROLES = ['ADMIN', 'MANAGER', 'SUPER_ADMIN'];

const getTenantVariableDefinitions = async (tenantId) => {
  if (!tenantId) return [];
  const definitions = await adapter.getCollection('variables', tenantId);
  return Array.isArray(definitions) ? definitions : [];
};

const buildTenantResponse = (tenant, role = 'ADMIN') => ({
  ...tenant,
  environment: normalizeTenantEnvironment(tenant?.environment),
  // Painel mostra a faixa de conta pausada; cliente de agencia fala com a agencia.
  billingPaused: isBillingBlocked(tenant),
  billingPausedBy: isBillingBlocked(tenant) ? (tenant.partnerId ? 'partner' : 'onion') : null,
  role
});

router.get('/', authenticate, authorize(['SUPER_ADMIN']), requireSuperAdminPermission(['tenants:read']), async (req, res) => {
  try {
    const tenants = await adapter.getCollection('tenants');
    res.json(tenants);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', authenticate, authorize(['SUPER_ADMIN']), requireSuperAdminPermission(['tenants:write']), async (req, res) => {
  try {
    const { name, slug, plan, status, settings, billing } = req.body;
    const tenant = {
      id: generateId('tenant'),
      name,
      slug: slug || '',
      plan: plan || 'basic',
      status: status || 'active',
      settings: settings || {
        maxUsers: 5,
        maxFlows: 10,
        maxChatsPerDay: 100
      },
      billing: {
        cpfCnpj: billing?.cpfCnpj || '',
        phone: billing?.phone || '',
        email: billing?.email || '',
        representative: billing?.representative || '',
        dueDay: billing?.dueDay || 10,
        paymentStatus: billing?.paymentStatus || 'open',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const tenants = await adapter.getCollection('tenants');
    tenants.push(tenant);
    await adapter.saveCollection('tenants', tenants);
    invalidateTenantCache();

    res.status(201).json(tenant);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:tenantId/users', authenticate, authorize(TENANT_MEMBER_READ_ROLES), async (req, res) => {
  try {
    const { tenantId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.tenantId !== tenantId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const users = await adapter.findMany('users', {
      query: { tenantId },
      projection: {
        _id: 0,
        id: 1,
        tenantId: 1,
        name: 1,
        username: 1,
        role: 1,
        status: 1,
        lastSeen: 1,
        ratingAvg: 1,
        ratingCount: 1,
        queues: 1
      }
    });
    const onlineIds = getOnlineUserIds();

    // Count active chats per agent
    const activeChats = await adapter.findMany('chats', {
      query: { tenantId, status: { $in: ['open', 'waiting'] } },
      projection: { agentId: 1 }
    });
    const chatCountByAgent = {};
    for (const chat of activeChats) {
      if (chat.agentId) {
        chatCountByAgent[chat.agentId] = (chatCountByAgent[chat.agentId] || 0) + 1;
      }
    }

    const usersWithoutPasswords = users.map((user) => ({
      ...user,
      isOnline: onlineIds.has(user.id),
      activeChats: chatCountByAgent[user.id] || 0
    }));
    res.json(usersWithoutPasswords);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:tenantId/analytics', authenticate, authorize(TENANT_MEMBER_READ_ROLES), async (req, res) => {
  try {
    const { tenantId } = req.params;

    if (req.user.role !== 'SUPER_ADMIN' && req.user.tenantId !== tenantId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const analytics = await getTenantAnalytics(tenantId);

    if (!analytics) {
      return res.status(404).json({ error: 'Tenant não encontrado' });
    }

    res.json(analytics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:tenantId/chats', authenticate, authorize(TENANT_MEMBER_READ_ROLES), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const summaryOnly = req.query.summary === '1' || req.query.summary === 'true';

    if (req.user.role !== 'SUPER_ADMIN' && req.user.tenantId !== tenantId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const chats = summaryOnly
      ? await adapter.findMany('activeChats', {
          query: { tenantId, status: { $ne: 'closed' } },
          projection: {
            _id: 0,
            id: 1,
            tenantId: 1,
            status: 1,
            queue: 1,
            queueId: 1,
            agentId: 1,
            agentName: 1,
            customerCpf: 1,
            customerPhone: 1,
            channel: 1,
            channelUserId: 1,
            channelChatId: 1,
            createdAt: 1,
            updatedAt: 1,
            waitingSince: 1,
            vars: 1,
            variables: 1,
            messages: { $slice: -1 }
          },
          sort: { updatedAt: -1, createdAt: -1 }
        })
      : await adapter.findMany('activeChats', {
          query: { tenantId, status: { $ne: 'closed' } },
          sort: { updatedAt: -1, createdAt: -1 }
        });
    const operationalChats = Array.isArray(chats) ? chats : [];

    if (!summaryOnly) {
      return res.json(operationalChats);
    }

    await migrateTenantSecretVars(tenantId);
    const variableDefinitions = await getTenantVariableDefinitions(tenantId);
    const sanitized = sanitizeChatCollectionForAgent(operationalChats, variableDefinitions);
    const summaries = buildChatSummaryCollection(sanitized);

    // Enrich with contact names from tenant's contact list
    const contacts = await adapter.findMany('contacts', {
      query: { tenantId },
      projection: {
        _id: 0,
        name: 1,
        phones: 1,
        normalizedPrimaryPhone: 1
      }
    });
    if (Array.isArray(contacts) && contacts.length > 0) {
      const phoneToName = new Map();
      for (const contact of contacts) {
        if (!contact.name) continue;
        const phones = Array.isArray(contact.phones) ? contact.phones : [];
        for (const phone of phones) {
          if (phone.normalizedNumber) phoneToName.set(phone.normalizedNumber, contact.name);
          if (phone.waId) phoneToName.set(phone.waId.replace(/\D/g, ''), contact.name);
        }
        if (contact.normalizedPrimaryPhone) phoneToName.set(contact.normalizedPrimaryPhone, contact.name);
      }
      for (const chat of summaries) {
        const userId = String(chat.channelUserId || '').replace(/\D/g, '');
        if (userId && phoneToName.has(userId)) {
          chat.contactName = phoneToName.get(userId);
        }
      }
    }

    res.json(summaries);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:tenantId/settings', authenticate, authorize([...TENANT_MEMBER_READ_ROLES, 'AGENT']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.tenantId !== tenantId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const settings = await getTenantSettings(tenantId);
    if (req.user.role === 'AGENT') {
      return res.json({
        tenantId,
        agentViewVars: Array.isArray(settings?.agentViewVars) ? settings.agentViewVars : []
      });
    }
    res.json(settings || { tenantId, agentViewVars: [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:tenantId/settings', authenticate, authorize(['ADMIN']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.tenantId !== tenantId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const saved = await saveTenantSettings(tenantId, req.body || {});
    res.json(saved || { tenantId, agentViewVars: [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:tenantId/switch', authenticate, authorize(['SUPER_ADMIN']), requireSuperAdminPermission(['tenants:switch']), async (req, res) => {
  try {
    if (req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const { tenantId } = req.params;
    const tenants = await adapter.getCollection('tenants');
    const tenant = tenants.find(t => t.id === tenantId);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant não encontrado' });
    }

    res.json({
      id: tenant.id,
      name: tenant.name,
      role: req.user.role
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const tenantCurrentHandler = async (req, res) => {
  try {
    if (req.user.role === 'SUPER_ADMIN') {
      const tenants = await adapter.getCollection('tenants');
      if (tenants.length === 0) {
        return res.json({ id: 'super_admin', name: 'Super Admin', role: 'SUPER_ADMIN' });
      }
      return res.json({ id: 'super_admin', name: 'Super Admin', role: 'SUPER_ADMIN', tenants: tenants.length });
    }

    const tenants = await adapter.getCollection('tenants');
    const tenant = tenants.find(t => t.id === req.user.tenantId);
    res.json(tenant ? buildTenantResponse(tenant, req.user.role) : { id: 'unknown', name: 'Unknown' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

router.get('/tenant/current', authenticate, tenantCurrentHandler);

// Ambiente da empresa. Afeta contagem em metricas e cobranca, entao fica
// restrito ao SUPER_ADMIN.
router.patch('/:tenantId/environment', authenticate, authorize(['SUPER_ADMIN']), requireSuperAdminPermission(['tenants:write']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const environment = String(req.body?.environment || '').trim().toLowerCase();
    if (!TENANT_ENVIRONMENTS.includes(environment)) {
      return res.status(400).json({ error: `Ambiente invalido. Use ${TENANT_ENVIRONMENTS.join(' ou ')}.` });
    }

    const tenant = await adapter.findOne('tenants', { id: tenantId });
    if (!tenant) return res.status(404).json({ error: 'Tenant nao encontrado' });

    const saved = await setTenantEnvironment(tenantId, environment);
    await createLog('TENANT_ENVIRONMENT_UPDATE', {
      tenantId,
      environment: saved,
      previous: normalizeTenantEnvironment(tenant.environment)
    }, req.user.id);

    res.json({ tenantId, environment: saved });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:tenantId', authenticate, authorize(['SUPER_ADMIN']), requireSuperAdminPermission(['tenants:write']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenants = await adapter.getCollection('tenants');
    const tenantIndex = tenants.findIndex(t => t.id === tenantId);
    if (tenantIndex === -1) {
      return res.status(404).json({ error: 'Tenant não encontrado' });
    }

    let billingUpdate = req.body.billing !== undefined ? req.body.billing : undefined;
    if (billingUpdate) {
      const existing = tenants[tenantIndex];
      const prevStatus = existing?.billing?.paymentStatus;
      const nextStatus = billingUpdate.paymentStatus;
      if (nextStatus === 'overdue' && prevStatus !== 'overdue' && !billingUpdate.overdueAt) {
        billingUpdate = { ...billingUpdate, overdueAt: new Date().toISOString() };
      }
      if (nextStatus === 'paid') {
        billingUpdate = { ...billingUpdate, overdueAt: null, blocked: false, blockedAt: null, blockReason: null };
      }
    }

    const updates = {
      name: req.body.name,
      slug: req.body.slug,
      plan: req.body.plan,
      status: req.body.status,
      settings: req.body.settings,
      billing: billingUpdate,
    };

    const updatedTenant = {
      ...tenants[tenantIndex],
      ...Object.entries(updates).reduce((acc, [key, value]) => value !== undefined ? { ...acc, [key]: value } : acc, {}),
      updatedAt: new Date().toISOString()
    };

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('tenants');
    await collection.updateOne({ id: tenantId }, { $set: updatedTenant });
    invalidateTenantCache();

    res.json(updatedTenant);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:tenantId', destructiveLimiter, authenticate, authorize(['SUPER_ADMIN']), requireSuperAdminPermission(['tenants:delete']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const confirm = req.body?.confirm === true || req.body?.confirm === 'true';
    const reason = String(req.body?.reason || '').trim();
    if (!confirm || reason.length < 3) {
      return res.status(400).json({ error: 'Confirmação e motivo são obrigatórios' });
    }
    const tenants = await adapter.getCollection('tenants');
    const tenant = tenants.find(t => t.id === tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant não encontrado' });
    }

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('tenants');
    await collection.deleteOne({ id: tenantId });
    invalidateTenantCache();

    await createLog(
      'TENANT_DELETE',
      { tenantId: tenant.id, name: tenant.name, reason },
      req.user?.id || 'system'
    );

    noteDestructiveAction({
      userId: req.user?.id,
      role: req.user?.role,
      tenantId: tenant.id,
      clientIp: req.ip,
      path: req.originalUrl || req.url,
      method: req.method,
      kind: 'tenant_delete'
    }).catch(() => {});

    res.json({ message: 'Tenant removido', deleted: tenant });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Billing routes — static BEFORE dynamic /:tenantId/* ──

router.post('/billing/auto-block-scan', authenticate, authorize(['SUPER_ADMIN']), requireSuperAdminPermission(['tenants:write']), async (req, res) => {
  try {
    const blocked = await runAutoBlockScan();
    invalidateTenantCache();
    res.json({ ok: true, newlyBlocked: blocked });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:tenantId/billing/block', authenticate, authorize(['SUPER_ADMIN']), requireSuperAdminPermission(['tenants:write']), async (req, res) => {
  try {
    const updated = await applyBillingBlock(req.params.tenantId, true, 'manual');
    if (!updated) return res.status(404).json({ error: 'Tenant não encontrado' });
    invalidateTenantCache();
    res.json({ ok: true, billing: updated.billing });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:tenantId/billing/unblock', authenticate, authorize(['SUPER_ADMIN']), requireSuperAdminPermission(['tenants:write']), async (req, res) => {
  try {
    const updated = await applyBillingBlock(req.params.tenantId, false);
    if (!updated) return res.status(404).json({ error: 'Tenant não encontrado' });
    invalidateTenantCache();
    res.json({ ok: true, billing: updated.billing });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:tenantId/billing/trust-unblock', authenticate, authorize(['SUPER_ADMIN']), requireSuperAdminPermission(['tenants:write']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { untilDate } = req.body;
    if (!untilDate) return res.status(400).json({ error: 'untilDate é obrigatório' });

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('tenants');
    const tenant = await collection.findOne({ id: tenantId });
    if (!tenant) return res.status(404).json({ error: 'Tenant não encontrado' });

    const currentMonth = new Date().toISOString().slice(0, 7);
    if (tenant.billing?.trustUnblockUsedMonth === currentMonth) {
      return res.status(409).json({ error: 'Desbloqueio de confiança já utilizado este mês. Disponível novamente no próximo mês.' });
    }

    const now = new Date().toISOString();
    const billing = {
      ...(tenant.billing || {}),
      blocked: false,
      blockedAt: null,
      blockReason: null,
      trustUnblockUntil: new Date(untilDate).toISOString(),
      trustUnblockUsedMonth: currentMonth,
      trustUnblockGrantedAt: now,
    };

    await collection.updateOne({ id: tenantId }, { $set: { billing, updatedAt: now } });
    invalidateTenantCache();
    res.json({ ok: true, billing });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
export { tenantCurrentHandler };
