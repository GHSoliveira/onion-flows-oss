import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import { dataSubjectLimiter, destructiveLimiter } from '../middleware/rateLimits.js';
import { noteDestructiveAction } from '../services/deleteBurstTracker.js';
import { isActiveOutreachEnabled } from '../services/tenantLimits.js';
import { isTenantBillingPaused } from '../services/billingGuard.js';
import adapter from '../../db/DatabaseAdapter.js';
import { contactSchema } from '../schemas/index.js';
import { createLog } from '../services/logs.js';
import { listOutreachHistory } from '../services/outreachHistory.js';
import {
  createOutreachCampaign,
  getOutreachCampaignById,
  getOutreachCampaignMaxContacts,
  listOutreachCampaigns,
  wakeOutreachCampaignWorker
} from '../services/outreachCampaignWorker.js';
import { performWhatsAppContactOutreach } from '../services/contactOutreach.js';
import { enqueueCampaignProcessing } from '../queues/campaignQueue.js';
import { isBullMqEnabled } from '../services/redisClient.js';
import { generateId } from '../utils/helpers.js';
import { mask } from '../utils/pii.js';
import { eraseDataSubject, findDataSubjectRecords, previewDataSubject } from '../services/dataSubject.js';
import { getWhatsAppConfig, resolveWhatsAppSender } from '../services/channelConfig.js';
import {
  blockWhatsAppUsers,
  isWhatsAppUserBlocked,
  unblockWhatsAppUsers
} from '../services/whatsappApi.js';
import {
  normalizeIdentities,
  identitiesFromLegacyPhones,
  phonesFromIdentities,
  getContactDisplayName,
  buildIdentity
} from '../utils/channelIdentity.js';

const router = express.Router();

// MANAGER tem acesso de LEITURA a contatos (relatórios, histórico de outreach)
// mas não pode criar/editar/apagar nem disparar ações externas (campanhas, mensagens).
const allowedRoles = ['ADMIN', 'MANAGER', 'AGENT', 'SUPER_ADMIN'];
const writeRoles = ['ADMIN', 'AGENT', 'SUPER_ADMIN'];
const whatsappModerationRoles = ['ADMIN', 'SUPER_ADMIN'];

const normalizeDigits = (value) => String(value || '').replace(/\D/g, '');

const resolveContactWhatsAppTarget = (contact, phoneEntryId = null) => {
  const phones = (Array.isArray(contact?.phones) ? contact.phones : [])
    .filter((phone) => String(phone?.channel || '').toLowerCase() === 'whatsapp');
  const identities = (Array.isArray(contact?.channelIdentities) ? contact.channelIdentities : [])
    .filter((identity) => String(identity?.channel || '').toLowerCase() === 'whatsapp');
  const requestedId = String(phoneEntryId || '').trim();
  const phone = (requestedId ? phones.find((item) => (
    String(item?.id || '') === requestedId
    || normalizeDigits(item?.waId || item?.normalizedNumber || item?.number) === normalizeDigits(requestedId)
  )) : null)
    || phones.find((item) => item?.isPrimary)
    || phones[0]
    || null;
  const identity = (requestedId ? identities.find((item) => (
    String(item?.id || '') === requestedId
    || normalizeDigits(item?.channelMeta?.waId || item?.normalizedIdentifier || item?.identifier) === normalizeDigits(requestedId)
  )) : null)
    || identities.find((item) => item?.isPrimary)
    || identities.find((item) => normalizeDigits(item?.identifier) === normalizeDigits(phone?.normalizedNumber || phone?.number))
    || identities[0]
    || null;
  const identifier = normalizeDigits(
    identity?.channelMeta?.waId
    || phone?.waId
    || identity?.normalizedIdentifier
    || identity?.identifier
    || phone?.normalizedNumber
    || phone?.number
  );
  if (!identifier) return null;
  return {
    phoneEntryId: phone?.id || identity?.id || null,
    identifier,
    displayValue: phone?.number || identity?.displayValue || `+${identifier}`
  };
};

const resolveWhatsAppModerationContext = async ({ tenantId, senderPhoneNumberId }) => {
  const config = await getWhatsAppConfig(tenantId);
  if (!config?.enabled || !config?.accessToken) {
    const error = new Error('Canal WhatsApp nao configurado para este tenant.');
    error.status = 409;
    throw error;
  }
  const sender = resolveWhatsAppSender(config, senderPhoneNumberId || null);
  if (!sender?.phoneNumberId) {
    const error = new Error('Numero remetente do WhatsApp nao encontrado.');
    error.status = 400;
    throw error;
  }
  return { accessToken: config.accessToken, sender };
};

// Aceita identities do payload novo OU phones do payload legacy. Quando vierem
// só phones, deriva identities; quando vierem só identities, deriva phones
// (espelho legacy para clientes que ainda não migraram). Garante invariantes
// de unicidade e exatamente uma primária.
const buildIdentitiesFromInput = (data) => {
  const explicit = Array.isArray(data?.channelIdentities) ? data.channelIdentities : [];
  const fromForm = explicit
    .map((entry, index) => buildIdentity({
      channel: entry?.channel,
      rawIdentifier: entry?.identifier || entry?.normalizedIdentifier || entry?.displayValue,
      handle: entry?.handle,
      displayName: entry?.channelDisplayName,
      channelMeta: entry?.channelMeta,
      label: entry?.label,
      isPrimary: Boolean(entry?.isPrimary) || (explicit.length === 1 && index === 0),
      optedIn: entry?.optedIn,
      existing: entry?.id ? entry : null
    }))
    .filter(Boolean);
  if (fromForm.length) return normalizeIdentities(fromForm);
  return normalizeIdentities(identitiesFromLegacyPhones(data?.phones || []));
};

const buildContactPayload = (data) => {
  const tags = Array.isArray(data?.tags)
    ? data.tags.map((tag) => String(tag || '').trim()).filter(Boolean)
    : [];
  const channelIdentities = buildIdentitiesFromInput(data);
  const phones = phonesFromIdentities(channelIdentities); // espelho legacy
  const primaryIdentity = channelIdentities.find((entry) => entry.isPrimary) || channelIdentities[0] || null;
  const primaryPhone = phones.find((phone) => phone.isPrimary) || phones[0] || null;

  const agentDefinedName = String(data?.agentDefinedName ?? data?.name ?? '').trim();
  const fallbackName = getContactDisplayName({ agentDefinedName, channelIdentities });

  return {
    name: agentDefinedName || fallbackName,
    agentDefinedName: agentDefinedName || null,
    company: String(data?.company || '').trim() || null,
    email: String(data?.email || '').trim() || null,
    notes: String(data?.notes || '').trim() || null,
    tags,
    phones,                       // espelho legacy
    channelIdentities,            // fonte primária
    primaryChannel: primaryIdentity?.channel || primaryPhone?.channel || null,
    primaryIdentifier: primaryIdentity?.identifier || null,
    primaryPhone: primaryPhone?.number || null,
    normalizedPrimaryPhone: primaryPhone?.normalizedNumber || null
  };
};

const buildContactDocument = ({ parsed, tenantId, userId, suffix = '' }) => {
  const payload = buildContactPayload(parsed);
  const now = new Date().toISOString();
  const idSuffix = suffix || Math.random().toString(36).slice(2, 8);
  return {
    id: generateId('contact'),
    ...payload,
    tenantId,
    createdBy: userId,
    updatedBy: userId,
    createdAt: now,
    updatedAt: now
  };
};

const ensureContactAccess = (req, contact) => {
  if (!contact) return false;
  if (req.user.role === 'SUPER_ADMIN') {
    if (!req.tenantId) return true;
    return String(contact.tenantId || '') === String(req.tenantId);
  }
  return String(contact.tenantId || '') === String(req.tenantId || '');
};

// Bloqueia disparo de outreach (template ao cliente) quando o tenant não tem o
// recurso de atendimento ativo habilitado. Aplicado só nas rotas que de fato
// enviam mensagem ao cliente — CRUD de contato segue liberado.
const requireActiveOutreach = async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (await isTenantBillingPaused(tenantId)) {
      return res.status(402).json({
        error: 'Envios ativos pausados por pendência de pagamento. Voltam sozinhos quando a conta for regularizada.',
        code: 'billing_paused'
      });
    }
    if (await isActiveOutreachEnabled(tenantId)) return next();
    return res.status(403).json({
      error: 'Atendimento ativo não está habilitado no seu plano.',
      code: 'active_outreach_disabled'
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

router.get('/', authenticate, authorize(allowedRoles, { permission: 'atendimento.historico' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    const q = String(req.query.q || '').trim().toLowerCase();
    const tag = String(req.query.tag || '').trim().toLowerCase();
    const channel = String(req.query.channel || '').trim().toLowerCase();
    const outreachStatus = String(req.query.outreachStatus || '').trim().toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit || 200) || 200, 1), 500);
    // Com ?page= a resposta vira pagina + total (a tela de Contatos). Sem ele,
    // continua a lista simples de antes para quem ja usa.
    const paged = req.query.page !== undefined;
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);

    const contacts = await adapter.findMany('contacts', {
      query: tenantId ? { tenantId } : {},
      projection: {
        _id: 0,
        id: 1,
        tenantId: 1,
        name: 1,
        agentDefinedName: 1,
        company: 1,
        email: 1,
        notes: 1,
        phones: 1,
        channelIdentities: 1,
        tags: 1,
        lastContactAt: 1,
        lastContactChannel: 1,
        lastTemplateId: 1,
        lastTemplateName: 1,
        lastPhoneUsed: 1,
        lastOutreachId: 1,
        lastOutreachStatus: 1,
        lastOutreachStatusAt: 1,
        createdAt: 1,
        updatedAt: 1
      },
      sort: { updatedAt: -1, createdAt: -1 },
      limit: paged || q || tag || channel || outreachStatus ? 5000 : limit
    });

    // Migração on-read: contatos antigos com só `phones` ganham
    // `channelIdentities` derivadas. Read-only — nenhuma escrita aqui.
    for (const contact of contacts) {
      if (!Array.isArray(contact.channelIdentities) || contact.channelIdentities.length === 0) {
        contact.channelIdentities = identitiesFromLegacyPhones(contact.phones || []);
      }
      if (!contact.agentDefinedName) {
        contact.agentDefinedName = contact.name || null;
      }
      contact.displayName = getContactDisplayName(contact);
    }
    const filtered = contacts
      .filter((contact) => {
        if (!ensureContactAccess(req, contact)) return false;

        if (tag) {
          const tags = Array.isArray(contact.tags) ? contact.tags : [];
          if (!tags.some((item) => String(item || '').toLowerCase() === tag)) {
            return false;
          }
        }

        if (channel) {
          const identities = Array.isArray(contact.channelIdentities) ? contact.channelIdentities : [];
          const phones = Array.isArray(contact.phones) ? contact.phones : [];
          const hasIdentity = identities.some((entry) => String(entry?.channel || '').toLowerCase() === channel);
          const hasPhone = phones.some((phone) => String(phone?.channel || '').toLowerCase() === channel);
          if (!hasIdentity && !hasPhone) return false;
        }

        if (outreachStatus) {
          const lastStatus = String(contact.lastOutreachStatus || '').toLowerCase();
          if (lastStatus !== outreachStatus) {
            return false;
          }
        }

        if (!q) return true;

        const qDigits = normalizeDigits(q);
        const identities = Array.isArray(contact.channelIdentities) ? contact.channelIdentities : [];
        const haystack = [
          contact.name,
          contact.agentDefinedName,
          contact.displayName,
          contact.company,
          contact.email,
          contact.notes,
          contact.lastTemplateName,
          contact.lastOutreachStatus,
          ...(Array.isArray(contact.tags) ? contact.tags : []),
          ...(Array.isArray(contact.phones) ? contact.phones.flatMap((phone) => [phone?.label, phone?.number, phone?.waId, phone?.normalizedNumber]) : []),
          ...identities.flatMap((entry) => [entry?.identifier, entry?.normalizedIdentifier, entry?.displayValue, entry?.channelDisplayName, entry?.handle, entry?.label])
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        if (haystack.includes(q)) return true;
        if (qDigits) {
          const phoneDigits = (Array.isArray(contact.phones) ? contact.phones : []).map((phone) => phone?.normalizedNumber || '').join(' ');
          return phoneDigits.includes(qDigits);
        }
        return false;
      })
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));

    if (!paged) return res.json(filtered.slice(0, limit));

    const hasWhatsApp = (contact) => (contact.channelIdentities || []).some((entry) => String(entry?.channel || '').toLowerCase() === 'whatsapp')
      || (contact.phones || []).some((phone) => String(phone?.channel || 'whatsapp').toLowerCase() === 'whatsapp');
    const tags = [...new Set(contacts.filter((contact) => ensureContactAccess(req, contact))
      .flatMap((contact) => (Array.isArray(contact.tags) ? contact.tags : []))
      .map((item) => String(item || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const pages = Math.max(1, Math.ceil(filtered.length / limit));
    const currentPage = Math.min(page, pages);
    res.json({
      items: filtered.slice((currentPage - 1) * limit, currentPage * limit),
      total: filtered.length,
      withWhatsApp: filtered.filter(hasWhatsApp).length,
      tags,
      page: currentPage,
      limit,
      pages
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/outreach/history', authenticate, authorize(allowedRoles, { permission: 'atendimento.historico' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    const contactId = String(req.query.contactId || '').trim() || null;
    const limit = Math.min(Math.max(Number(req.query.limit || 30) || 30, 1), 100);

    const items = await listOutreachHistory({ tenantId, contactId, limit });
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/outreach/campaigns', authenticate, authorize(allowedRoles, { permission: 'atendimento.historico' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    const limit = Math.min(Math.max(Number(req.query.limit || 20) || 20, 1), 100);
    const items = await listOutreachCampaigns({ tenantId, limit });
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Permite ao front (inclusive AGENT) saber se pode disparar outreach, para
// esconder/desabilitar os botões de "entrar em contato".
router.get('/outreach/capabilities', authenticate, authorize(allowedRoles, { permission: 'atendimento.historico' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    const [enabled, pausada] = await Promise.all([isActiveOutreachEnabled(tenantId), isTenantBillingPaused(tenantId)]);
    res.json({ activeOutreach: enabled && !pausada, billingPaused: pausada });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/outreach/campaigns/:id', authenticate, authorize(allowedRoles, { permission: 'atendimento.historico' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    const campaign = await getOutreachCampaignById({
      tenantId,
      campaignId: req.params.id
    });

    if (!campaign) {
      return res.status(404).json({ error: 'Campanha nao encontrada' });
    }

    res.json(campaign);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/outreach/campaigns', authenticate, authorize(writeRoles, { permission: 'atendimento.ativo' }), requireTenant, requireActiveOutreach, async (req, res) => {
  try {
    if (Array.isArray(req.body?.contactIds) && req.body.contactIds.length > getOutreachCampaignMaxContacts()) {
      return res.status(400).json({
        code: 'campaign_contact_limit_exceeded',
        message: 'A campanha excede o limite permitido de contatos.',
        correlationId: req.correlationId
      });
    }
    const campaign = await createOutreachCampaign({
      tenantId: req.tenantId || req.user?.tenantId || null,
      channel: String(req.body?.channel || '').trim().toLowerCase(),
      contactIds: Array.isArray(req.body?.contactIds) ? req.body.contactIds : [],
      templateId: String(req.body?.templateId || '').trim(),
      senderPhoneNumberId: String(req.body?.senderPhoneNumberId || '').trim() || null,
      values: req.body?.values && typeof req.body.values === 'object' ? req.body.values : {},
      actor: req.user
    });

    if (isBullMqEnabled()) {
      const job = await enqueueCampaignProcessing({ campaignId: campaign.id, reason: 'campaign_created' });
      if (!job) {
        console.warn('[CONTACT_OUTREACH_CAMPAIGN] BullMQ indisponivel; usando worker local');
        wakeOutreachCampaignWorker();
      }
    } else {
      wakeOutreachCampaignWorker();
    }
    res.status(201).json(campaign);
  } catch (error) {
    const status = Number(error?.status || 500);
    res.status(status).json({
      code: error?.code || 'campaign_create_failed',
      message: error.message || 'Falha ao criar campanha',
      correlationId: req.correlationId
    });
  }
});

router.post('/', authenticate, authorize(writeRoles, { manager: 'contatos', permission: 'contatos.editar' }), requireTenant, async (req, res) => {
  try {
    const parsed = contactSchema.parse(req.body || {});
    const tenantId = req.user.role === 'SUPER_ADMIN' ? (req.body?.tenantId || req.tenantId) : req.tenantId;
    const contact = buildContactDocument({
      parsed,
      tenantId,
      userId: req.user.id
    });

    if (!Array.isArray(contact.phones) || !contact.phones.length) {
      return res.status(400).json({ error: 'Informe pelo menos um telefone valido.' });
    }

    if (!adapter.db) await adapter.init();
    await adapter.db.collection('contacts').insertOne(contact);
    await createLog('CONTACT_CREATE', { id: contact.id, tenantId, name: contact.name }, req.user.id);
    res.status(201).json(contact);
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: error.errors });
    }
    res.status(500).json({ error: error.message });
  }
});

router.post('/bulk', authenticate, authorize(writeRoles, { manager: 'contatos', permission: 'contatos.editar' }), requireTenant, async (req, res) => {
  try {
    const items = Array.isArray(req.body)
      ? req.body
      : (Array.isArray(req.body?.contacts) ? req.body.contacts : []);

    if (!items.length) {
      return res.status(400).json({ error: 'Informe um array de contatos em "contacts".' });
    }

    const tenantId = req.user.role === 'SUPER_ADMIN'
      ? (req.body?.tenantId || req.query?.targetTenantId || req.tenantId || null)
      : req.tenantId;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio para cadastro em lote.' });
    }

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('contacts');

    const contactsToInsert = [];
    const failed = [];

    items.forEach((item, index) => {
      const parsed = contactSchema.safeParse(item || {});
      if (!parsed.success) {
        failed.push({
          index,
          error: parsed.error?.errors || 'Contato invalido'
        });
        return;
      }

      const contact = buildContactDocument({
        parsed: parsed.data,
        tenantId,
        userId: req.user.id,
        suffix: `${index}_${Math.random().toString(36).slice(2, 6)}`
      });

      if (!Array.isArray(contact.phones) || !contact.phones.length) {
        failed.push({
          index,
          error: 'Informe pelo menos um telefone valido.'
        });
        return;
      }

      contactsToInsert.push(contact);
    });

    if (contactsToInsert.length > 0) {
      await collection.insertMany(contactsToInsert, { ordered: false });
    }

    await createLog('CONTACT_BULK_CREATE', {
      tenantId,
      requested: items.length,
      created: contactsToInsert.length,
      failed: failed.length
    }, req.user.id);

    return res.status(201).json({
      ok: true,
      tenantId,
      requested: items.length,
      createdCount: contactsToInsert.length,
      failedCount: failed.length,
      created: contactsToInsert.map((contact) => ({
        id: contact.id,
        name: contact.name
      })),
      failed
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Falha ao cadastrar contatos em lote.' });
  }
});

router.get('/:id/whatsapp/block-status', authenticate, authorize(whatsappModerationRoles, { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const contact = await adapter.findOne('contacts', { id: req.params.id });
    if (!contact) return res.status(404).json({ error: 'Contato nao encontrado' });
    if (!ensureContactAccess(req, contact)) return res.status(403).json({ error: 'Acesso negado' });

    const target = resolveContactWhatsAppTarget(contact, req.query?.phoneEntryId);
    if (!target) return res.status(400).json({ error: 'Contato sem numero WhatsApp valido.' });
    const tenantId = req.tenantId || contact.tenantId;
    const { accessToken, sender } = await resolveWhatsAppModerationContext({
      tenantId,
      senderPhoneNumberId: req.query?.senderPhoneNumberId
    });
    const status = await isWhatsAppUserBlocked({
      accessToken,
      phoneNumberId: sender.phoneNumberId,
      user: target.identifier
    });
    return res.json({
      ok: true,
      contactId: contact.id,
      phoneEntryId: target.phoneEntryId,
      senderPhoneNumberId: sender.phoneNumberId,
      blocked: status.blocked,
      waId: status.waId,
      complete: status.complete
    });
  } catch (error) {
    return res.status(Number(error?.status || 500)).json({
      error: error?.message || 'Falha ao consultar bloqueio na Meta.',
      code: error?.code || 'whatsapp_block_status_failed'
    });
  }
});

router.post('/:id/whatsapp/block', authenticate, authorize(whatsappModerationRoles, { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const contact = await adapter.findOne('contacts', { id: req.params.id });
    if (!contact) return res.status(404).json({ error: 'Contato nao encontrado' });
    if (!ensureContactAccess(req, contact)) return res.status(403).json({ error: 'Acesso negado' });

    const target = resolveContactWhatsAppTarget(contact, req.body?.phoneEntryId);
    if (!target) return res.status(400).json({ error: 'Contato sem numero WhatsApp valido.' });
    const tenantId = req.tenantId || contact.tenantId;
    const { accessToken, sender } = await resolveWhatsAppModerationContext({
      tenantId,
      senderPhoneNumberId: req.body?.senderPhoneNumberId
    });
    const current = await isWhatsAppUserBlocked({ accessToken, phoneNumberId: sender.phoneNumberId, user: target.identifier });
    let waId = current.waId;
    let alreadyBlocked = current.blocked;

    if (!current.blocked) {
      const result = await blockWhatsAppUsers({
        accessToken,
        phoneNumberId: sender.phoneNumberId,
        users: [target.identifier]
      });
      const added = Array.isArray(result?.block_users?.added_users) ? result.block_users.added_users : [];
      const failed = Array.isArray(result?.block_users?.failed_users) ? result.block_users.failed_users : [];
      if (!added.length) {
        const details = failed[0]?.error?.message || failed[0]?.message || 'A Meta nao confirmou o bloqueio.';
        const error = new Error(details);
        error.status = 400;
        throw error;
      }
      waId = normalizeDigits(added[0]?.wa_id) || target.identifier;
      alreadyBlocked = false;
    }

    await createLog('WHATSAPP_CONTACT_BLOCKED', {
      tenantId,
      contactId: contact.id,
      senderPhoneNumberId: sender.phoneNumberId,
      waId: mask.phone(waId),
      alreadyBlocked
    }, req.user.id);
    return res.json({ ok: true, blocked: true, alreadyBlocked, waId, senderPhoneNumberId: sender.phoneNumberId });
  } catch (error) {
    return res.status(Number(error?.status || 500)).json({
      error: error?.message || 'Falha ao bloquear contato na Meta.',
      code: error?.code || 'whatsapp_contact_block_failed'
    });
  }
});

router.delete('/:id/whatsapp/block', authenticate, authorize(whatsappModerationRoles, { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const contact = await adapter.findOne('contacts', { id: req.params.id });
    if (!contact) return res.status(404).json({ error: 'Contato nao encontrado' });
    if (!ensureContactAccess(req, contact)) return res.status(403).json({ error: 'Acesso negado' });

    const target = resolveContactWhatsAppTarget(contact, req.body?.phoneEntryId);
    if (!target) return res.status(400).json({ error: 'Contato sem numero WhatsApp valido.' });
    const tenantId = req.tenantId || contact.tenantId;
    const { accessToken, sender } = await resolveWhatsAppModerationContext({
      tenantId,
      senderPhoneNumberId: req.body?.senderPhoneNumberId
    });
    const current = await isWhatsAppUserBlocked({ accessToken, phoneNumberId: sender.phoneNumberId, user: target.identifier });
    let waId = current.waId;
    let alreadyUnblocked = !current.blocked;

    if (current.blocked) {
      const result = await unblockWhatsAppUsers({
        accessToken,
        phoneNumberId: sender.phoneNumberId,
        users: [current.waId || target.identifier]
      });
      const removed = Array.isArray(result?.block_users?.removed_users) ? result.block_users.removed_users : [];
      const failed = Array.isArray(result?.block_users?.failed_users) ? result.block_users.failed_users : [];
      if (!removed.length) {
        const details = failed[0]?.error?.message || failed[0]?.message || 'A Meta nao confirmou o desbloqueio.';
        const error = new Error(details);
        error.status = 400;
        throw error;
      }
      waId = normalizeDigits(removed[0]?.wa_id) || current.waId || target.identifier;
      alreadyUnblocked = false;
    }

    await createLog('WHATSAPP_CONTACT_UNBLOCKED', {
      tenantId,
      contactId: contact.id,
      senderPhoneNumberId: sender.phoneNumberId,
      waId: mask.phone(waId),
      alreadyUnblocked
    }, req.user.id);
    return res.json({ ok: true, blocked: false, alreadyUnblocked, waId, senderPhoneNumberId: sender.phoneNumberId });
  } catch (error) {
    return res.status(Number(error?.status || 500)).json({
      error: error?.message || 'Falha ao desbloquear contato na Meta.',
      code: error?.code || 'whatsapp_contact_unblock_failed'
    });
  }
});

router.put('/:id', authenticate, authorize(writeRoles, { manager: 'contatos', permission: 'contatos.editar' }), requireTenant, async (req, res) => {
  try {
    const parsed = contactSchema.parse(req.body || {});
    if (!adapter.db) await adapter.init();

    const collection = adapter.db.collection('contacts');
    const existing = await collection.findOne({ id: req.params.id });
    if (!existing) {
      return res.status(404).json({ error: 'Contato nao encontrado' });
    }
    if (!ensureContactAccess(req, existing)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const payload = buildContactPayload(parsed);
    if (!payload.phones.length) {
      return res.status(400).json({ error: 'Informe pelo menos um telefone valido.' });
    }

    const nextContact = {
      ...existing,
      ...payload,
      updatedBy: req.user.id,
      updatedAt: new Date().toISOString()
    };

    await collection.updateOne({ id: existing.id }, { $set: nextContact });
    await createLog('CONTACT_UPDATE', { id: existing.id, tenantId: existing.tenantId, name: nextContact.name }, req.user.id);
    res.json(nextContact);
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: error.errors });
    }
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authenticate, authorize(writeRoles, { manager: 'contatos', permission: 'contatos.editar' }), requireTenant, async (req, res) => {
  try {
    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('contacts');
    const existing = await collection.findOne({ id: req.params.id });

    if (!existing) {
      return res.status(404).json({ error: 'Contato nao encontrado' });
    }
    if (!ensureContactAccess(req, existing)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    await collection.deleteOne({ id: existing.id });
    await createLog('CONTACT_DELETE', { id: existing.id, tenantId: existing.tenantId, name: existing.name }, req.user.id);
    res.json({ deleted: existing });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/', destructiveLimiter, authenticate, authorize(writeRoles, { permission: 'dados.lgpd' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.user.role === 'SUPER_ADMIN'
      ? (req.body?.tenantId || req.query?.targetTenantId || req.tenantId || null)
      : req.tenantId;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio para exclusao em lote.' });
    }

    const tag = String(req.query?.tag || req.body?.tag || '').trim().toLowerCase();
    const contacts = await adapter.getCollection('contacts', tenantId);
    const scopedContacts = (Array.isArray(contacts) ? contacts : [])
      .filter((contact) => String(contact?.tenantId || '') === String(tenantId));

    const targetContacts = tag
      ? scopedContacts.filter((contact) => {
        const tags = Array.isArray(contact?.tags) ? contact.tags : [];
        return tags.some((item) => String(item || '').trim().toLowerCase() === tag);
      })
      : scopedContacts;

    const targetIds = targetContacts
      .map((contact) => contact?.id)
      .filter(Boolean);

    if (!targetIds.length) {
      return res.json({
        ok: true,
        tenantId,
        mode: tag ? 'tag' : 'all',
        tag: tag || null,
        deletedCount: 0
      });
    }

    if (!adapter.db) await adapter.init();
    const result = await adapter.db.collection('contacts').deleteMany({
      tenantId,
      id: { $in: targetIds }
    });

    await createLog('CONTACT_BULK_DELETE', {
      tenantId,
      mode: tag ? 'tag' : 'all',
      tag: tag || null,
      requested: targetIds.length,
      deleted: Number(result?.deletedCount || 0)
    }, req.user.id);

    return res.json({
      ok: true,
      tenantId,
      mode: tag ? 'tag' : 'all',
      tag: tag || null,
      deletedCount: Number(result?.deletedCount || 0)
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Falha ao excluir contatos em lote.' });
  }
});

router.post('/:id/outreach', authenticate, authorize(writeRoles, { permission: 'atendimento.ativo' }), requireTenant, requireActiveOutreach, async (req, res) => {
  try {
    const channel = String(req.body?.channel || '').trim().toLowerCase();
    if (channel !== 'whatsapp') {
      return res.status(400).json({ error: 'No momento o atendimento ativo suporta apenas WhatsApp.' });
    }

    if (!adapter.db) await adapter.init();
    const contactsCollection = adapter.db.collection('contacts');
    const contact = await contactsCollection.findOne({ id: req.params.id });

    if (!contact) {
      return res.status(404).json({ error: 'Contato nao encontrado' });
    }
    if (!ensureContactAccess(req, contact)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const phoneEntryId = String(req.body?.phoneEntryId || '').trim();
    const templateId = String(req.body?.templateId || '').trim();
    const senderPhoneNumberId = String(req.body?.senderPhoneNumberId || '').trim() || null;
    const values = req.body?.values && typeof req.body.values === 'object' ? req.body.values : {};

    if (!phoneEntryId || !templateId) {
      return res.status(400).json({ error: 'Selecione numero e template para continuar.' });
    }

    const result = await performWhatsAppContactOutreach({
      tenantId: req.tenantId || req.user?.tenantId || contact.tenantId || null,
      contact,
      phoneEntryId,
      templateId,
      senderPhoneNumberId,
      values,
      actor: req.user
    });

    res.json({
      ok: true,
      channel,
      chat: result.chat,
      outreach: result.outreach,
      providerMessageId: result.providerMessageId
    });
  } catch (error) {
    const status = Number(error?.status || 500);
    res.status(status).json({ error: error.message || 'Falha ao iniciar atendimento ativo' });
  }
});

// --- LGPD: data subject erasure ---
//
// Atende ao direito de eliminação previsto no Art. 18, VI da LGPD. Remove
// dados identificáveis de um titular dentro do tenant atual:
//   - contatos cujo telefone normalizado bate com o informado
//   - chats abertos/fechados com customerCpf ou channelUserId correspondente
//   - chatEvents associados a esses chats
//
// O endpoint é privilegiado: exige ADMIN, MANAGER ou SUPER_ADMIN. Requer
// `confirm: true` e um motivo curto no body para gerar rastro auditável.
// A resposta retorna contadores; o log persistido só conserva identificadores
// mascarados (CPF/telefone) — nunca os valores brutos.

const ERASURE_ROLES = ['ADMIN', 'SUPER_ADMIN'];

// Direito de portabilidade (Art. 18, V). Devolve um JSON consolidado com
// todos os dados que identificamos para o titular dentro do tenant atual.
// Não é desbloqueio de campos cifrados de outros tenants — apenas o que já
// estaria visível para um operador ADMIN/MANAGER do tenant.
router.post('/data-subject/export', dataSubjectLimiter, authenticate, authorize(ERASURE_ROLES, { permission: 'dados.lgpd' }), requireTenant, async (req, res) => {
  try {
    const rawCpf = String(req.body?.cpf || '').trim();
    const rawPhone = String(req.body?.phone || '').trim();
    const reason = String(req.body?.reason || '').trim();

    if (!rawCpf && !rawPhone) {
      return res.status(400).json({ error: 'Informe cpf ou phone para localizar o titular.' });
    }
    if (reason.length < 3) {
      return res.status(400).json({ error: 'Motivo (mín. 3 caracteres) é obrigatório.' });
    }

    const normalizedPhone = normalizeDigits(rawPhone);
    const tenantId = req.tenantId;
    if (!adapter.db) await adapter.init();

    // Mesma busca da eliminacao: todas as variacoes do telefone contra todos os
    // campos de telefone, para o export nunca mostrar menos do que seria apagado.
    const { chats, chatIds, contacts } = await findDataSubjectRecords({ tenantId, cpf: rawCpf, phone: rawPhone });
    const chatMessages = chatIds.length
      ? await adapter.db.collection('chatMessages')
          .find({ tenantId, chatId: { $in: chatIds } }, { projection: { _id: 0 } })
          .sort({ timestamp: 1 })
          .toArray()
      : [];
    const events = chatIds.length
      ? await adapter.db.collection('chatEvents')
          .find({ tenantId, chatId: { $in: chatIds } }, { projection: { _id: 0 } })
          .sort({ timestamp: 1 })
          .toArray()
      : [];

    const outreachHistory = [];
    for (const contact of contacts) {
      try {
        const items = await listOutreachHistory({ tenantId, contactId: contact.id, limit: 500 });
        if (Array.isArray(items)) outreachHistory.push(...items);
      } catch (_error) {
        // ignore — outreach is best-effort in the export bundle
      }
    }
    const contactIds = contacts.map((contact) => contact.id).filter(Boolean);
    const messageIds = chatMessages.map((message) => message.messageId).filter(Boolean);
    const classifications = (chatIds.length || contactIds.length || messageIds.length)
      ? await adapter.db.collection('messageClassifications').find({
          tenantId,
          $or: [
            ...(chatIds.length ? [{ chatId: { $in: chatIds } }] : []),
            ...(contactIds.length ? [{ contactId: { $in: contactIds } }] : []),
            ...(messageIds.length ? [{ messageId: { $in: messageIds } }] : [])
          ]
        }, { projection: { _id: 0, rawProviderResponse: 0 } }).toArray()
      : [];

    // Strip vars marcadas como secureVars (essas pertencem ao tenant, não ao titular)
    const sanitizedChats = chats.map((chat) => {
      const { secureVars, secureVarNames, ...rest } = chat;
      return rest;
    });

    await createLog('LGPD_DATA_SUBJECT_EXPORT', {
      tenantId,
      cpf: rawCpf || null,
      phone: rawPhone || null,
      reason,
      counts: {
        chats: sanitizedChats.length,
        chatEvents: events.length,
        chatMessages: chatMessages.length,
        contacts: contacts.length,
        outreachHistory: outreachHistory.length,
        classifications: classifications.length
      }
    }, req.user.id);

    const filename = `data-subject-${(rawCpf || normalizedPhone || 'export').replace(/[^0-9a-zA-Z_-]/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json({
      generatedAt: new Date().toISOString(),
      tenantId,
      identifiers: {
        cpf: rawCpf || null,
        phone: rawPhone || null,
        normalizedPhone: normalizedPhone || null
      },
      reason,
      data: {
        contacts,
        chats: sanitizedChats,
        chatEvents: events,
        chatMessages,
        outreachHistory,
        classifications
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Previa da eliminacao: so contadores e nomes dos contatos, para quem vai apagar
// ver o que sai antes de confirmar. Nao devolve conteudo de mensagem.
router.post('/data-subject/preview', dataSubjectLimiter, authenticate, authorize(ERASURE_ROLES, { permission: 'dados.lgpd' }), requireTenant, async (req, res) => {
  try {
    const rawCpf = String(req.body?.cpf || '').trim();
    const rawPhone = String(req.body?.phone || '').trim();
    if (!rawCpf && !rawPhone) {
      return res.status(400).json({ error: 'Informe cpf ou phone para localizar o titular.' });
    }
    const preview = await previewDataSubject({ tenantId: req.tenantId, cpf: rawCpf, phone: rawPhone });
    res.json({
      identifiers: { cpf: rawCpf ? mask.cpf(rawCpf) : null, phone: rawPhone ? mask.phone(rawPhone) : null },
      ...preview
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/data-subject/erase', dataSubjectLimiter, authenticate, authorize(ERASURE_ROLES, { permission: 'dados.lgpd' }), requireTenant, async (req, res) => {
  try {
    const rawCpf = String(req.body?.cpf || '').trim();
    const rawPhone = String(req.body?.phone || '').trim();
    const reason = String(req.body?.reason || '').trim();
    const confirm = req.body?.confirm === true || req.body?.confirm === 'true';

    if (!rawCpf && !rawPhone) {
      return res.status(400).json({ error: 'Informe cpf ou phone para localizar o titular.' });
    }
    if (!confirm || reason.length < 3) {
      return res.status(400).json({ error: 'Confirmação e motivo (mín. 3 caracteres) são obrigatórios.' });
    }

    const tenantId = req.tenantId;
    // Busca por todas as variacoes do telefone e todos os campos de telefone;
    // a consulta antiga deixava o contato para tras quando o formato diferia.
    const deleted = await eraseDataSubject({ tenantId, cpf: rawCpf, phone: rawPhone });

    // O log guarda so identificadores mascarados, como promete o cabecalho.
    await createLog('LGPD_DATA_SUBJECT_ERASURE', {
      tenantId,
      cpf: rawCpf ? mask.cpf(rawCpf) : null,
      phone: rawPhone ? mask.phone(rawPhone) : null,
      reason,
      deleted
    }, req.user.id);

    noteDestructiveAction({
      userId: req.user.id,
      role: req.user.role,
      tenantId,
      clientIp: req.ip,
      path: req.originalUrl || req.url,
      method: req.method,
      kind: 'data_subject_erase'
    }).catch(() => {});

    res.json({
      ok: true,
      identifiers: {
        cpf: rawCpf ? mask.cpf(rawCpf) : null,
        phone: rawPhone ? mask.phone(rawPhone) : null
      },
      deleted
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
