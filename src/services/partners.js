// Parceiro (nivel H): agencia que revende a plataforma com a propria marca.
// Tem uma carteira de tenants (tenant.partnerId) e usuarios com papel PARTNER
// (user.partnerId). Fora de um cliente, o Parceiro so usa as rotas dele; dentro
// de um cliente da carteira, o authenticate o trata como ADMIN daquele tenant.
import bcrypt from 'bcrypt';
import adapter from '../../db/DatabaseAdapter.js';
import { normalizeSubdomain } from './partnerDomains.js';
import { generateId } from '../utils/helpers.js';
import { createLog } from './logs.js';
import { invalidateTenantCache } from './tenantLimits.js';
import { applyBillingBlock } from './billingGuard.js';
import { isUsernameTaken } from './passwords.js';

export const PARTNER_ROLE = 'PARTNER';
const DEFAULT_MAX_TENANTS = 20;
const ACCESS_LOG_WINDOW_MS = 30 * 60 * 1000;
const ultimoAcesso = new Map();

const falha = (message, status = 400) => Object.assign(new Error(message), { status });
const agora = () => new Date().toISOString();

export const getPartner = (partnerId) => (partnerId ? adapter.findOne('partners', { id: partnerId }, { projection: { _id: 0 } }) : null);

// Tenant da carteira do Parceiro, ou null. Toda checagem de acesso passa aqui.
export const findPartnerTenant = async (partnerId, tenantId) => {
  if (!partnerId || !tenantId) return null;
  const tenant = await adapter.findOne('tenants', { id: String(tenantId) }, { projection: { _id: 0 } });
  return tenant && tenant.partnerId === partnerId ? tenant : null;
};

// Entrada do Parceiro num cliente: registra no log no maximo uma vez a cada 30
// min por pessoa e cliente, para o historico nao virar ruido.
export const notePartnerTenantAccess = async (user, tenantId, path = null) => {
  const chave = `${user.id}:${tenantId}`;
  const antes = ultimoAcesso.get(chave) || 0;
  if (Date.now() - antes < ACCESS_LOG_WINDOW_MS) return;
  ultimoAcesso.set(chave, Date.now());
  await createLog('PARTNER_TENANT_ACCESS', { partnerId: user.partnerId, tenantId, path }, user.id).catch(() => {});
};

const resumoTenant = (tenant, extras = {}) => ({
  id: tenant.id,
  name: tenant.name,
  plan: tenant.plan || 'basic',
  status: tenant.billing?.blocked ? 'suspended' : (tenant.status || 'active'),
  maxUsers: tenant.settings?.maxUsers ?? null,
  createdAt: tenant.createdAt || null,
  ...extras
});

export const listPartnerTenants = async (partnerId) => {
  const tenants = (await adapter.findMany('tenants', { query: { partnerId } })) || [];
  return Promise.all(tenants.map(async (tenant) => {
    const [users, openChats] = await Promise.all([
      adapter.countDocuments('users', { tenantId: tenant.id }),
      adapter.countDocuments('activeChats', { tenantId: tenant.id, status: { $in: ['open', 'bot', 'waiting'] } })
    ]);
    return resumoTenant(tenant, { users, openChats });
  }));
};

const novoUsuario = async ({ name, username, password, role, tenantId = null, partnerId = null }, actorId) => {
  if (await isUsernameTaken(username)) throw falha('Esse usuario ja existe na plataforma. Escolha outro.');
  const user = {
    id: generateId('u'),
    name,
    username,
    password: await bcrypt.hash(password, 10),
    role,
    queues: [],
    permissions: [],
    managerPermissions: [],
    tenantId,
    ...(partnerId ? { partnerId } : {}),
    availabilityMode: 'auto',
    notificationPreferences: { browser: true, sound: true, email: false },
    createdAt: agora(),
    updatedAt: agora(),
    createdBy: actorId
  };
  await adapter.insertOne('users', user);
  const { password: _, ...semSenha } = user;
  return semSenha;
};

const ATRASO_MENSAGEM = 'Há uma fatura em atraso. Pague para criar ou reativar clientes.';

export const createPartnerTenant = async (partner, { name, plan, maxUsers, admin }, actorId) => {
  if (partner.billing?.blocked) throw falha(ATRASO_MENSAGEM, 402);
  const atuais = await adapter.countDocuments('tenants', { partnerId: partner.id });
  const limite = partner.maxTenants ?? DEFAULT_MAX_TENANTS;
  if (atuais >= limite) throw falha(`Limite de ${limite} clientes atingido. Fale com a Onion para aumentar.`, 409);
  if (await isUsernameTaken(admin.username)) throw falha('Esse usuario ja existe na plataforma. Escolha outro.');

  const tenant = {
    id: generateId('tenant'),
    name,
    slug: '',
    plan: plan || 'basic',
    status: 'active',
    partnerId: partner.id,
    settings: { maxUsers: maxUsers || 5, maxFlows: 10, maxChatsPerDay: 100 },
    billing: { cpfCnpj: '', phone: '', email: '', representative: '', dueDay: 10, paymentStatus: 'open' },
    createdAt: agora(),
    updatedAt: agora()
  };
  await adapter.insertOne('tenants', tenant);
  invalidateTenantCache();
  const adminUser = await novoUsuario({ ...admin, role: 'ADMIN', tenantId: tenant.id }, actorId);
  await createLog('PARTNER_TENANT_CREATE', { partnerId: partner.id, tenantId: tenant.id, adminUserId: adminUser.id }, actorId);
  return { tenant: resumoTenant(tenant, { users: 1, openChats: 0 }), admin: adminUser };
};

export const updatePartnerTenant = async (partner, tenantId, { name, plan, maxUsers, status }, actorId) => {
  const tenant = await findPartnerTenant(partner.id, tenantId);
  if (!tenant) throw falha('Cliente nao encontrado na sua carteira.', 404);
  // Com atraso, reativar furaria o bloqueio da cobranca.
  if (status === 'active' && partner.billing?.blocked) throw falha(ATRASO_MENSAGEM, 402);
  const set = { updatedAt: agora() };
  if (name !== undefined) set.name = name;
  if (plan !== undefined) set.plan = plan;
  if (maxUsers !== undefined) set['settings.maxUsers'] = maxUsers;
  await adapter.updateOne('tenants', { id: tenant.id }, { $set: set });
  // Suspender usa o mesmo bloqueio da cobranca: o bot para de responder.
  if (status === 'suspended' || status === 'active') await applyBillingBlock(tenant.id, status === 'suspended', 'partner');
  invalidateTenantCache();
  await createLog('PARTNER_TENANT_UPDATE', { partnerId: partner.id, tenantId: tenant.id, fields: Object.keys(set), status: status || null }, actorId);
  return resumoTenant(await adapter.findOne('tenants', { id: tenant.id }, { projection: { _id: 0 } }));
};

// --- Gestao de Parceiros pela Onion (super admin) ---

export const listPartners = async () => {
  const partners = (await adapter.getCollection('partners')) || [];
  return Promise.all(partners.map(async (partner) => ({
    ...partner,
    tenants: await adapter.countDocuments('tenants', { partnerId: partner.id }),
    accesses: await adapter.countDocuments('users', { partnerId: partner.id, role: PARTNER_ROLE })
  })));
};

// Mais um login de Parceiro para uma agencia que ja existe (a agencia que pediu
// um segundo acesso, ou a de demonstracao que nasceu sem login).
export const createPartnerAccess = async (partnerId, user, actorId) => {
  const partner = await getPartner(partnerId);
  if (!partner) throw falha('Parceiro não encontrado.', 404);
  const criado = await novoUsuario({ ...user, role: PARTNER_ROLE, partnerId }, actorId);
  await createLog('PARTNER_ACCESS_CREATE', { partnerId, userId: criado.id }, actorId);
  return criado;
};

export const createPartner = async ({ name, maxTenants, user, subdomain: enderecoPedido }, actorId) => {
  if (await isUsernameTaken(user.username)) throw falha('Esse usuario ja existe na plataforma. Escolha outro.');
  const subdomain = normalizeSubdomain(enderecoPedido);
  if (subdomain && await adapter.findOne('partners', { subdomain })) throw falha('Esse endereço já é de outro parceiro.', 409);
  const partner = {
    id: generateId('partner'),
    name,
    status: 'active',
    maxTenants: maxTenants || DEFAULT_MAX_TENANTS,
    branding: {},
    subdomain,
    createdAt: agora(),
    updatedAt: agora()
  };
  await adapter.insertOne('partners', partner);
  const partnerUser = await novoUsuario({ ...user, role: PARTNER_ROLE, partnerId: partner.id }, actorId);
  await createLog('PARTNER_CREATE', { partnerId: partner.id, userId: partnerUser.id }, actorId);
  return { partner, user: partnerUser };
};

export const assignTenantToPartner = async (tenantId, partnerId, actorId) => {
  const tenant = await adapter.findOne('tenants', { id: tenantId });
  if (!tenant) throw falha('Tenant nao encontrado.', 404);
  if (partnerId && !(await getPartner(partnerId))) throw falha('Parceiro nao encontrado.', 404);
  await adapter.updateOne('tenants', { id: tenantId }, { $set: { partnerId: partnerId || null, updatedAt: agora() } });
  invalidateTenantCache();
  await createLog('PARTNER_TENANT_ASSIGN', { tenantId, partnerId: partnerId || null, previous: tenant.partnerId || null }, actorId);
};

export const savePartnerBranding = async (partnerId, branding, actorId) => {
  await adapter.updateOne('partners', { id: partnerId }, { $set: { branding, updatedAt: agora() } });
  await createLog('PARTNER_BRANDING_UPDATE', { partnerId }, actorId);
  return branding;
};
