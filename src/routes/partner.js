import express from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { authorize, requireSuperAdminPermission } from '../middleware/authorization.js';
import { BRAND_COLOR_PATTERN, resolvePartnerBranding } from '../services/branding.js';
import { partnerUrl, setPartnerSubdomain } from '../services/partnerDomains.js';
import { createLog } from '../services/logs.js';
import {
  PARTNER_ROLE, assignTenantToPartner, createPartner, createPartnerAccess, createPartnerTenant, getPartner,
  listPartnerTenants, listPartners, savePartnerBranding, updatePartnerTenant
} from '../services/partners.js';
import {
  contarClientesAtivos, gerarFatura, getBillingSettings, listarFaturas, periodoDe, processarWebhook,
  saveBillingSettings, testBillingConnection, tokenDoWebhookConfere, updatePartnerBilling
} from '../services/partnerBilling.js';

// Painel do Parceiro (/api/partner) e gestao de Parceiros pela Onion
// (/api/partners). O Parceiro so enxerga a propria carteira: todo acesso a um
// tenant passa por findPartnerTenant.

const PLANOS = ['basic', 'pro', 'premium'];
const nome = z.string().trim().min(2).max(120);
const novoLogin = z.object({
  name: z.string().trim().min(1).max(120),
  username: z.string().trim().min(3).max(60),
  password: z.string().min(8).max(200)
}).strict();
const httpsUrl = z.union([
  z.string().trim().url().refine((value) => value.startsWith('https://'), 'Use um endereco https://'),
  z.literal('')
]).optional();
const marcaSchema = z.object({
  productName: z.string().trim().max(60).optional(),
  organizationName: z.string().trim().max(120).optional(),
  logoUrl: httpsUrl,
  faviconUrl: httpsUrl,
  loginImageUrl: httpsUrl,
  primaryColor: z.union([z.string().regex(BRAND_COLOR_PATTERN, 'Cor no formato #RRGGBB'), z.literal('')]).optional(),
  supportEmail: z.union([z.string().email(), z.literal('')]).optional(),
  supportWhatsapp: z.union([z.string().trim().regex(/^\+?[\d\s()-]{10,20}$/, 'WhatsApp com DDI e DDD'), z.literal('')]).optional()
}).strict();

const responderErro = (res, error) => {
  if (error?.name === 'ZodError') return res.status(400).json({ error: error.errors?.[0]?.message || 'Dados invalidos', details: error.errors });
  return res.status(error?.status || 500).json({ error: error?.status ? error.message : 'Falha ao processar o pedido' });
};

// --- Painel do Parceiro ---
export const partnerRouter = express.Router();

partnerRouter.use(authenticate, async (req, res, next) => {
  // Mesmo que o painel mande ?tenantId de um cliente, aqui vale a identidade
  // de Parceiro (req.partnerUser), nunca o ADMIN emprestado.
  const user = req.partnerUser;
  if (!user || user.role !== PARTNER_ROLE || !user.partnerId) return res.status(403).json({ error: 'Acesso negado' });
  const partner = await getPartner(user.partnerId);
  if (!partner || partner.status === 'suspended') return res.status(403).json({ error: 'Parceiro inativo' });
  req.partner = partner;
  req.partnerActor = user;
  next();
});

partnerRouter.get('/me', (req, res) => {
  const { id, name, maxTenants, status, subdomain } = req.partner;
  res.json({ partner: { id, name, maxTenants, status, subdomain: subdomain || null, url: partnerUrl(subdomain) }, user: { id: req.partnerActor.id, name: req.partnerActor.name } });
});

partnerRouter.get('/tenants', async (req, res) => {
  try {
    res.json({ items: await listPartnerTenants(req.partner.id), maxTenants: req.partner.maxTenants });
  } catch (error) {
    responderErro(res, error);
  }
});

partnerRouter.post('/tenants', async (req, res) => {
  try {
    const body = z.object({
      name: nome,
      plan: z.enum(PLANOS).optional(),
      maxUsers: z.number().int().min(1).max(200).optional(),
      admin: novoLogin
    }).strict().parse(req.body || {});
    res.status(201).json(await createPartnerTenant(req.partner, body, req.partnerActor.id));
  } catch (error) {
    responderErro(res, error);
  }
});

partnerRouter.patch('/tenants/:tenantId', async (req, res) => {
  try {
    const body = z.object({
      name: nome.optional(),
      plan: z.enum(PLANOS).optional(),
      maxUsers: z.number().int().min(1).max(200).optional(),
      status: z.enum(['active', 'suspended']).optional()
    }).strict().parse(req.body || {});
    res.json(await updatePartnerTenant(req.partner, req.params.tenantId, body, req.partnerActor.id));
  } catch (error) {
    responderErro(res, error);
  }
});

// Cobranca do proprio Parceiro: valor por cliente, clientes ativos e faturas.
partnerRouter.get('/billing', async (req, res) => {
  try {
    const billing = req.partner.billing || {};
    res.json({
      pricePerClient: billing.pricePerClient || 0,
      dueDay: billing.dueDay || 10,
      blocked: Boolean(billing.blocked),
      activeClients: await contarClientesAtivos(req.partner.id),
      invoices: (await listarFaturas(req.partner.id)).map(({ asaasPaymentId, lastError, ...fatura }) => fatura)
    });
  } catch (error) {
    responderErro(res, error);
  }
});

partnerRouter.get('/branding', async (req, res) => {
  try {
    res.json({ settings: req.partner.branding || {}, resolved: await resolvePartnerBranding(req.partner.id) });
  } catch (error) {
    responderErro(res, error);
  }
});

partnerRouter.patch('/branding', async (req, res) => {
  try {
    const branding = marcaSchema.parse(req.body || {});
    res.json({ settings: await savePartnerBranding(req.partner.id, branding, req.partnerActor.id) });
  } catch (error) {
    responderErro(res, error);
  }
});

// --- Gestao de Parceiros pela Onion ---
export const partnersAdminRouter = express.Router();
partnersAdminRouter.use(authenticate, authorize(['SUPER_ADMIN']));

partnersAdminRouter.get('/', requireSuperAdminPermission(['tenants:read']), async (req, res) => {
  try {
    res.json({ items: await listPartners() });
  } catch (error) {
    responderErro(res, error);
  }
});

partnersAdminRouter.post('/', requireSuperAdminPermission(['tenants:write']), async (req, res) => {
  try {
    const body = z.object({
      name: nome,
      maxTenants: z.number().int().min(1).max(1000).optional(),
      user: novoLogin,
      subdomain: z.string().max(60).nullable().optional()
    }).strict().parse(req.body || {});
    res.status(201).json(await createPartner(body, req.user.id));
  } catch (error) {
    responderErro(res, error);
  }
});

partnersAdminRouter.post('/:partnerId/access', requireSuperAdminPermission(['tenants:write']), async (req, res) => {
  try {
    const user = novoLogin.parse(req.body || {});
    res.status(201).json({ user: await createPartnerAccess(req.params.partnerId, user, req.user.id) });
  } catch (error) {
    responderErro(res, error);
  }
});

partnersAdminRouter.get('/billing-settings', requireSuperAdminPermission(['tenants:read']), async (req, res) => {
  try {
    res.json(await getBillingSettings());
  } catch (error) {
    responderErro(res, error);
  }
});

partnersAdminRouter.put('/billing-settings', requireSuperAdminPermission(['tenants:write']), async (req, res) => {
  try {
    const body = z.object({
      environment: z.enum(['sandbox', 'production']),
      apiKey: z.string().trim().max(500).optional()
    }).strict().parse(req.body || {});
    res.json(await saveBillingSettings(body, req.user.id));
  } catch (error) {
    responderErro(res, error);
  }
});

partnersAdminRouter.post('/billing-settings/test', requireSuperAdminPermission(['tenants:read']), async (req, res) => {
  try {
    res.json(await testBillingConnection());
  } catch (error) {
    responderErro(res, error);
  }
});

// Endereco proprio da agencia (<subdominio>.<AGENCY_ROOT_DOMAIN>); vazio tira o endereco.
partnersAdminRouter.patch('/:partnerId/address', requireSuperAdminPermission(['tenants:write']), async (req, res) => {
  try {
    const resultado = await setPartnerSubdomain(req.params.partnerId, req.body?.subdomain);
    await createLog('PARTNER_ADDRESS', { partnerId: req.params.partnerId, subdomain: resultado.subdomain }, req.user.id);
    res.json(resultado);
  } catch (error) {
    responderErro(res, error);
  }
});

partnersAdminRouter.patch('/:partnerId/billing', requireSuperAdminPermission(['tenants:write']), async (req, res) => {
  try {
    const body = z.object({
      pricePerClient: z.number().min(0).max(100000).optional(),
      dueDay: z.number().int().min(1).max(28).optional(),
      legalName: z.string().trim().max(160).optional(),
      cpfCnpj: z.string().trim().max(20).optional(),
      email: z.union([z.string().trim().email(), z.literal('')]).optional()
    }).strict().parse(req.body || {});
    res.json(await updatePartnerBilling(req.params.partnerId, body, req.user.id));
  } catch (error) {
    responderErro(res, error);
  }
});

partnersAdminRouter.get('/:partnerId/invoices', requireSuperAdminPermission(['tenants:read']), async (req, res) => {
  try {
    res.json({ items: await listarFaturas(req.params.partnerId) });
  } catch (error) {
    responderErro(res, error);
  }
});

// Gera a fatura do mes atual na hora (o ciclo automatico so comeca no mes
// seguinte ao primeiro valor definido).
partnersAdminRouter.post('/:partnerId/invoices/generate', requireSuperAdminPermission(['tenants:write']), async (req, res) => {
  try {
    const inicio = Date.now();
    const fatura = await gerarFatura(req.params.partnerId, periodoDe(), { forcar: true });
    if (!fatura) return res.status(409).json({ error: 'Defina o valor por cliente antes de gerar a fatura.' });
    // O painel avisa quando nao criou nada porque o mes ja tem fatura valendo.
    res.json({ ...fatura, alreadyExisted: new Date(fatura.updatedAt || 0).getTime() < inicio });
  } catch (error) {
    responderErro(res, error);
  }
});

partnersAdminRouter.put('/tenants/:tenantId', requireSuperAdminPermission(['tenants:write']), async (req, res) => {
  try {
    const { partnerId } = z.object({ partnerId: z.string().trim().min(1).nullable() }).strict().parse(req.body || {});
    await assignTenantToPartner(req.params.tenantId, partnerId, req.user.id);
    res.json({ ok: true });
  } catch (error) {
    responderErro(res, error);
  }
});

// --- Aviso de pagamento do Asaas (publico, autenticado pelo token do webhook) ---
export const partnerBillingWebhookRouter = express.Router();

partnerBillingWebhookRouter.post('/asaas/webhook', async (req, res) => {
  if (!(await tokenDoWebhookConfere(req.get('asaas-access-token')))) return res.status(401).json({ error: 'Token invalido' });
  try {
    res.json({ ok: true, ...(await processarWebhook(req.body || {})) });
  } catch (error) {
    // 500 faz o Asaas tentar de novo mais tarde.
    console.error('[PARTNER_BILLING_WEBHOOK]', error.message);
    res.status(500).json({ error: 'Falha ao processar o aviso' });
  }
});
