import adapter from '../../db/DatabaseAdapter.js';

const INCIDENT_MARKERS = ['ERROR', 'FAILED', 'FAILURE', 'INVALID', 'TIMEOUT', 'WHATSAPP_ERROR'];

const clamp = (value, min, max, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export const paginationFromQuery = (query = {}) => {
  const page = clamp(query.page, 1, 100000, 1);
  const limit = clamp(query.limit, 1, 100, 25);
  return { page, limit, skip: (page - 1) * limit };
};

export const isIncidentLog = (log = {}) => {
  const type = String(log.type || '').toUpperCase();
  return INCIDENT_MARKERS.some((marker) => type.includes(marker));
};

export const getTenantModuleOverview = async (tenantId) => {
  const activeStatuses = ['open', 'bot', 'human', 'waiting'];
  const [waitingChats, activeChats, unreadChats, campaigns, failedCampaignItems, contacts, agents, flows] = await Promise.all([
    adapter.countDocuments('activeChats', { tenantId, status: 'waiting' }),
    adapter.countDocuments('activeChats', { tenantId, status: { $in: activeStatuses } }),
    adapter.countDocuments('activeChats', { tenantId, unreadByAgentCount: { $gt: 0 } }),
    adapter.countDocuments('outreachCampaigns', { tenantId }),
    adapter.countDocuments('outreachCampaignItems', { tenantId, status: 'failed' }),
    adapter.countDocuments('contacts', { tenantId }),
    adapter.countDocuments('users', { tenantId, role: 'AGENT' }),
    adapter.countDocuments('flows', { tenantId })
  ]);

  return {
    tenantId,
    generatedAt: new Date().toISOString(),
    operation: { waitingChats, activeChats, unreadChats, campaigns, failedCampaignItems },
    automation: { flows },
    team: { agents },
    usage: { contacts }
  };
};

export const listTenantInbox = async (tenantId, query = {}) => {
  const { page, limit, skip } = paginationFromQuery(query);
  const filter = { tenantId };
  const status = String(query.status || '').trim();
  if (status) filter.status = status;

  const [items, total] = await Promise.all([
    adapter.findMany('activeChats', {
      query: filter,
      projection: {
        _id: 0, id: 1, status: 1, channel: 1, channelUserId: 1, customerCpf: 1,
        queue: 1, agentId: 1, agentName: 1, lastMessage: 1, lastMessageAt: 1,
        unreadByAgentCount: 1, messageCount: 1, createdAt: 1, updatedAt: 1
      },
      sort: { lastMessageAt: -1, updatedAt: -1 },
      skip,
      limit
    }),
    adapter.countDocuments('activeChats', filter)
  ]);
  return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

export const listTenantCampaigns = async (tenantId, query = {}) => {
  const { page, limit, skip } = paginationFromQuery(query);
  const filter = { tenantId };
  const status = String(query.status || '').trim();
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    adapter.findMany('outreachCampaigns', {
      query: filter,
      projection: {
        _id: 0, id: 1, name: 1, status: 1, channel: 1, templateId: 1,
        templateName: 1, senderPhoneNumberId: 1, totalContacts: 1,
        pendingCount: 1, successCount: 1, failedCount: 1, createdAt: 1, updatedAt: 1
      },
      sort: { updatedAt: -1 }, skip, limit
    }),
    adapter.countDocuments('outreachCampaigns', filter)
  ]);
  return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

export const listTenantLogs = async (tenantId, query = {}, incidentsOnly = false) => {
  const { page, limit, skip } = paginationFromQuery(query);
  if (!incidentsOnly) {
    const filter = { tenantId };
    const [items, total] = await Promise.all([
      adapter.findMany('systemLogs', {
        query: filter,
        projection: { _id: 0, id: 1, timestamp: 1, type: 1, message: 1, userId: 1, tenantId: 1 },
        sort: { timestamp: -1 }, skip, limit
      }),
      adapter.countDocuments('systemLogs', filter)
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  // Incident types are heterogeneous in legacy logs. Read a bounded window and
  // filter in-process until all producers use a normalized severity field.
  const window = await adapter.findMany('systemLogs', {
    query: { tenantId },
    projection: { _id: 0, id: 1, timestamp: 1, type: 1, message: 1, userId: 1, tenantId: 1 },
    sort: { timestamp: -1 },
    limit: 1000
  });
  const incidents = window.filter(isIncidentLog);
  const items = incidents.slice(skip, skip + limit);
  return { items, pagination: { page, limit, total: incidents.length, pages: Math.ceil(incidents.length / limit), bounded: true } };
};

export const listTenantIncidents = async (tenantId, query = {}) => {
  const { page, limit, skip } = paginationFromQuery(query);
  const filter = { tenantId };
  const status = String(query.status || '').trim();
  const severity = String(query.severity || '').trim();
  if (status) filter.status = status;
  if (severity) filter.severity = severity;
  const [items, total] = await Promise.all([
    adapter.findMany('tenantIncidents', {
      query: filter,
      projection: { _id: 0, fingerprint: 0 },
      sort: { lastSeenAt: -1 }, skip, limit
    }),
    adapter.countDocuments('tenantIncidents', filter)
  ]);
  if (total > 0) return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  return listTenantLogs(tenantId, query, true);
};

export const listTenantAudit = async (tenantId, query = {}) => {
  const { page, limit, skip } = paginationFromQuery(query);
  const filter = { tenantId };
  const type = String(query.type || '').trim();
  if (type) filter.type = type;
  const [items, total] = await Promise.all([
    adapter.findMany('tenantAuditEvents', {
      query: filter,
      projection: { _id: 0 },
      sort: { timestamp: -1 }, skip, limit
    }),
    adapter.countDocuments('tenantAuditEvents', filter)
  ]);
  if (total > 0) return { items: await withActorNames(tenantId, items), pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  return listTenantLogs(tenantId, query, false);
};

// Auditoria mostra quem fez pelo nome, nao pelo id interno do usuario. Sem
// filtro de tenant de proposito: super admin (tenantId null) tambem aparece.
const withActorNames = async (_tenantId, items) => {
  const ids = [...new Set(items.map((item) => item.actorId).filter(Boolean))];
  if (!ids.length) return items;
  const users = await adapter.findMany('users', { query: { id: { $in: ids } }, projection: { _id: 0, id: 1, name: 1, username: 1 } });
  const names = new Map(users.map((user) => [user.id, user.name || user.username]));
  return items.map((item) => ({ ...item, actorName: names.get(item.actorId) || (item.actorId === 'system' ? 'Sistema' : item.actorId) || null }));
};

export const getTenantUsage = async (tenantId) => {
  const collections = {
    contacts: 'contacts', chats: 'activeChats', messages: 'chatMessages', media: 'mediaAssets',
    flows: 'flows', templates: 'templates', users: 'users', campaigns: 'outreachCampaigns'
  };
  const entries = await Promise.all(Object.entries(collections).map(async ([key, collection]) => [
    key,
    await adapter.countDocuments(collection, { tenantId })
  ]));
  return { tenantId, generatedAt: new Date().toISOString(), counts: Object.fromEntries(entries) };
};

export const getTenantPerformance = async (tenantId, query = {}) => {
  const { getBottlenecks } = await import('./analyticsService.js');
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const defaultTo = now.toISOString();
  const from = String(query.from || defaultFrom);
  const to = String(query.to || defaultTo);
  const report = await getBottlenecks({ tenantId, from, to });
  const users = await adapter.findMany('users', {
    query: { tenantId, role: 'AGENT' },
    projection: { _id: 0, id: 1, name: 1, ratingAvg: 1, ratingCount: 1, status: 1 },
    sort: { name: 1 },
    limit: 500
  });
  const activityByAgent = new Map((report?.agentes || []).map((agent) => [agent.agentId, agent]));
  const items = users.map((user) => {
    const activity = activityByAgent.get(user.id) || {};
    return {
      id: user.id,
      name: user.name || user.id,
      status: user.status || 'active',
      atendidos: activity.atendidos || 0,
      emAtendimento: activity.emAtendimento || 0,
      duracaoMediaMin: activity.duracaoMediaMin ?? null,
      duracaoP95Min: activity.duracaoP95Min ?? null,
      ratingAvg: Number(user.ratingAvg || 0),
      ratingCount: Number(user.ratingCount || 0)
    };
  });
  const knownIds = new Set(users.map((user) => user.id));
  for (const activity of report?.agentes || []) {
    if (knownIds.has(activity.agentId)) continue;
    items.push({
      id: activity.agentId,
      name: activity.name || activity.agentId,
      status: 'unknown',
      ...activity,
      ratingAvg: 0,
      ratingCount: 0
    });
  }
  return {
    range: report?.range || { from, to },
    summary: {
      agents: items.length,
      atendidos: items.reduce((total, item) => total + item.atendidos, 0),
      emAtendimento: items.reduce((total, item) => total + item.emAtendimento, 0)
    },
    items
  };
};

export const getTenantModuleSettings = async (tenantId, moduleKey) => {
  const document = await adapter.findOne('tenantModuleSettings', { tenantId }, { projection: { _id: 0 } });
  return document?.modules?.[moduleKey] || {};
};

export const updateTenantModuleSettings = async (tenantId, moduleKey, value, userId) => {
  const now = new Date().toISOString();
  await adapter.updateOne(
    'tenantModuleSettings',
    { tenantId },
    {
      $set: {
        id: `tenant_modules_${tenantId}`,
        tenantId,
        [`modules.${moduleKey}`]: value,
        [`moduleUpdatedAt.${moduleKey}`]: now,
        updatedAt: now,
        updatedBy: userId
      }
    },
    { upsert: true }
  );
  return value;
};
