import adapter from '../../db/DatabaseAdapter.js';

const DEFAULT_SETTINGS = {
  maxUsers: 5,
  maxFlows: 10,
  maxChatsPerDay: 100
};

const TENANT_CACHE_TTL_MS = 10000;
let cachedTenants = null;
let cachedTenantsAt = 0;

const tenantsFresh = () => cachedTenants && Date.now() - cachedTenantsAt < TENANT_CACHE_TTL_MS;

export const invalidateTenantCache = () => {
  cachedTenants = null;
  cachedTenantsAt = 0;
};

const toDateKey = (date) => {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
};

export const getTenantById = async (tenantId) => {
  if (!tenantId) return null;
  const tenants = tenantsFresh() ? cachedTenants : await adapter.getCollection('tenants');
  if (!tenantsFresh()) {
    cachedTenants = tenants;
    cachedTenantsAt = Date.now();
  }
  return tenants.find(t => t.id === tenantId) || null;
};

export const getTenantSettings = async (tenantId) => {
  const tenant = await getTenantById(tenantId);
  return {
    ...DEFAULT_SETTINGS,
    ...(tenant?.settings || {})
  };
};

export const getUsageCounts = async (tenantId) => {
  const [users, flows, chats] = await Promise.all([
    adapter.getCollection('users', tenantId),
    adapter.getCollection('flows', tenantId),
    adapter.getCollection('activeChats', tenantId)
  ]);

  const todayKey = toDateKey(new Date());
  const chatsToday = (chats || []).filter(c => toDateKey(c.createdAt) === todayKey).length;

  return {
    users: (users || []).length,
    flows: (flows || []).length,
    chatsToday
  };
};

// Atendimento ativo (outreach via template) é um recurso pago. Desligado por
// padrão — o SUPER_ADMIN liga em tenant.settings.activeOutreachEnabled para
// quem contrata o plano com esse recurso.
export const isActiveOutreachEnabled = async (tenantId) => {
  if (!tenantId) return false;
  const settings = await getTenantSettings(tenantId);
  return settings?.activeOutreachEnabled === true;
};

export const ensureTenantLimit = async (tenantId, type) => {
  if (!tenantId) return;

  const settings = await getTenantSettings(tenantId);
  const usage = await getUsageCounts(tenantId);

  if (type === 'users' && usage.users >= settings.maxUsers) {
    throw new Error(`Limite de usuários atingido (${usage.users}/${settings.maxUsers}).`);
  }
  if (type === 'flows' && usage.flows >= settings.maxFlows) {
    throw new Error(`Limite de fluxos atingido (${usage.flows}/${settings.maxFlows}).`);
  }
  if (type === 'chats' && usage.chatsToday >= settings.maxChatsPerDay) {
    throw new Error(`Limite diário de chats atingido (${usage.chatsToday}/${settings.maxChatsPerDay}).`);
  }
};
