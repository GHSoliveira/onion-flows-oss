import adapter from '../../db/DatabaseAdapter.js';
import { createLog, getIo } from './logs.js';
import { getWhatsAppConfig, resolveWhatsAppSender } from './channelConfig.js';
import { performWhatsAppContactOutreach, resolveContactWhatsAppPhone } from './contactOutreach.js';
import { generateId } from '../utils/helpers.js';
import { isContactSuppressed } from './contactSuppression.js';
import { createTurizmoEvent, enqueueTurizmoEvent } from './integrationOutbox.js';
import { enrollContactInCadence } from './cadenceEngine.js';
import { enqueueTurizmoDelivery } from '../queues/turizmoQueue.js';
import { consumeOutreachQuota, waitOutreachJitter } from './outreachRateLimit.js';
import { nowIso } from './outreachDomain.js';
import { envInt } from '../utils/env.js';
import { checkCampaignQuality } from './outreachQualityGuard.js';
import { pauseCampaignIfBillingBlocked } from './billingGuard.js';
import { syncCampaignCounters } from './outreachMetrics.js';

const COLLECTION = 'outreachCampaigns';
const ITEM_COLLECTION = 'outreachCampaignItems';
const PROCESSABLE_STATUSES = ['pending', 'processing'];
const DEFAULT_INTERVAL_MS = Number(process.env.OUTREACH_CAMPAIGN_INTERVAL_MS || 3000);
const IDLE_INTERVAL_MS = Number(process.env.OUTREACH_CAMPAIGN_IDLE_INTERVAL_MS || 30000);
const MAX_IDLE_INTERVAL_MS = Number(process.env.OUTREACH_CAMPAIGN_MAX_IDLE_INTERVAL_MS || 60000);

export const getOutreachCampaignMaxContacts = () => envInt(
  'OUTREACH_CAMPAIGN_MAX_CONTACTS',
  250,
  { min: 1, max: 1000 }
);

export const validateOutreachCampaignContactLimit = (contactIds = []) => {
  const uniqueContactIds = dedupeIds(contactIds);
  if (uniqueContactIds.length > getOutreachCampaignMaxContacts()) {
    const error = new Error('A campanha excede o limite permitido de contatos.');
    error.status = 400;
    error.code = 'campaign_contact_limit_exceeded';
    throw error;
  }
  return uniqueContactIds;
};

let workerTimer = null;
let workerBusy = false;
let workerIdleDelayMs = Math.max(DEFAULT_INTERVAL_MS, IDLE_INTERVAL_MS);

const ensureDb = async () => {
  if (!adapter.db) {
    await adapter.init();
  }
  return adapter.db;
};

const createCampaignId = () => generateId('campaign');

const dedupeIds = (values = []) => [...new Set(
  (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
)];

const summarizeCampaign = (campaign) => {
  if (Number.isFinite(Number(campaign?.totalContacts))) {
    const totalContacts = Number(campaign.totalContacts || 0);
    const pendingCount = Number(campaign.pendingCount || 0);
    const successCount = Number(campaign.successCount || 0);
    const failedCount = Number(campaign.failedCount || 0);
    const processedCount = Math.max(0, totalContacts - pendingCount);
    const progressPercent = totalContacts ? Math.round((processedCount / totalContacts) * 100) : 0;
    return {
      totalContacts,
      processedCount,
      successCount,
      failedCount,
      pendingCount,
      progressPercent,
      status: campaign.status || (pendingCount > 0 ? 'pending' : 'completed')
    };
  }

  const items = Array.isArray(campaign?.items) ? campaign.items : [];
  const processedCount = items.filter((item) => item.status !== 'pending').length;
  const successCount = items.filter((item) => item.status === 'sent').length;
  const failedCount = items.filter((item) => item.status === 'failed').length;
  const pendingCount = items.filter((item) => ['pending', 'scheduled', 'sending'].includes(item.status)).length;
  const progressPercent = items.length ? Math.round((processedCount / items.length) * 100) : 0;

  let status = 'pending';
  if (pendingCount > 0 && processedCount > 0) {
    status = 'processing';
  } else if (pendingCount === 0 && successCount > 0 && failedCount > 0) {
    status = 'completed_with_errors';
  } else if (pendingCount === 0 && failedCount > 0) {
    status = 'failed';
  } else if (pendingCount === 0) {
    status = 'completed';
  }

  return {
    totalContacts: items.length,
    processedCount,
    successCount,
    failedCount,
    pendingCount,
    progressPercent,
    status
  };
};

const emitCampaignUpdate = (campaign, event = 'campaign_update') => {
  if (!campaign?.tenantId) return;
  const io = getIo();
  if (!io) return;
  io.to(`tenant:${campaign.tenantId}`).emit(event, { campaign: normalizeCampaign(campaign) });
};

const emitCampaignIntegrationEvent = async (campaign, type) => {
  // O Turizmo recebe estes contadores; entao recalcula antes de fechar.
  if (type === 'campaign.completed') {
    const contadores = await syncCampaignCounters({ tenantId: campaign.tenantId, campaignId: campaign.id }).catch(() => null);
    if (contadores) campaign = { ...campaign, ...contadores };
  }
  const event = await enqueueTurizmoEvent(createTurizmoEvent({
    tenantId: campaign.tenantId,
    type,
    aggregateType: 'campaign',
    aggregateId: campaign.id,
    idempotencyKey: `${type}:${campaign.id}`,
    data: type === 'campaign.started'
      ? { campaignId: campaign.id, turizmoCampaignId: campaign.turizmoCampaignId || null, startedAt: campaign.startedAt || nowIso() }
      : {
          campaignId: campaign.id,
          turizmoCampaignId: campaign.turizmoCampaignId || null,
          sentCount: Number(campaign.sentCount ?? campaign.successCount ?? 0),
          failedCount: Number(campaign.failedCount || 0),
          repliedCount: Number(campaign.repliedCount || 0),
          positiveCount: Number(campaign.positiveCount || 0),
          finishedAt: campaign.finishedAt || nowIso()
        }
  }));
  if (event) enqueueTurizmoDelivery({ outboxId: event.id }).catch(() => {});
};

const normalizeCampaign = (campaign) => ({
  ...campaign,
  ...summarizeCampaign(campaign)
});

const sanitizeValues = (values) => (values && typeof values === 'object' ? values : {});

export const listOutreachCampaigns = async ({ tenantId, limit = 20 }) => {
  if (!tenantId) return [];
  const db = await ensureDb();
  const items = await db.collection(COLLECTION)
    .find({ tenantId }, { projection: { items: 0 } })
    .sort({ createdAt: -1, updatedAt: -1 })
    .limit(Math.min(Math.max(Number(limit || 20) || 20, 1), 100))
    .toArray();
  return items.map(normalizeCampaign);
};

export const getOutreachCampaignById = async ({ tenantId, campaignId }) => {
  if (!tenantId || !campaignId) return null;
  const db = await ensureDb();
  const item = await db.collection(COLLECTION).findOne({ id: campaignId, tenantId });
  if (!item) return null;
  const separateItems = await db.collection(ITEM_COLLECTION)
    .find({ tenantId, campaignId }, { projection: { _id: 0 } })
    .sort({ createdAt: 1 })
    .limit(10000)
    .toArray();
  return normalizeCampaign({
    ...item,
    items: separateItems.length ? separateItems : (Array.isArray(item.items) ? item.items : [])
  });
};

export const createOutreachCampaign = async ({
  tenantId,
  name = null,
  channel = 'whatsapp',
  contactIds = [],
  templateId,
  senderPhoneNumberId = null,
  values = {},
  cadenceId = null,
  scheduledAt = null,
  timezone = 'America/Sao_Paulo',
  turizmoLeadByContactId = {},
  turizmoCompanyByContactId = {},
  turizmoCampaignId = null,
  integrationSource = null,
  actor = null
}) => {
  if (!tenantId) {
    const error = new Error('tenantId obrigatorio');
    error.status = 400;
    throw error;
  }

  if (String(channel || '').trim().toLowerCase() !== 'whatsapp') {
    const error = new Error('No momento o disparo em massa suporta apenas WhatsApp.');
    error.status = 400;
    throw error;
  }

  const uniqueContactIds = validateOutreachCampaignContactLimit(contactIds);
  if (uniqueContactIds.length === 0) {
    const error = new Error('Selecione pelo menos um contato.');
    error.status = 400;
    throw error;
  }
  if (!templateId) {
    const error = new Error('Selecione um template para continuar.');
    error.status = 400;
    throw error;
  }

  const db = await ensureDb();
  const config = await getWhatsAppConfig(tenantId);
  const sender = resolveWhatsAppSender(config, senderPhoneNumberId || null);
  if (senderPhoneNumberId && !sender) {
    const error = new Error('Numero remetente invalido para este tenant.');
    error.status = 400;
    throw error;
  }
  if (!config?.enabled || !config?.accessToken || !sender?.phoneNumberId) {
    const error = new Error('Canal WhatsApp nao esta configurado para este tenant.');
    error.status = 400;
    throw error;
  }

  const template = await db.collection('whatsappTemplates').findOne({ id: templateId, tenantId });
  if (!template) {
    const error = new Error('Template WhatsApp nao encontrado.');
    error.status = 404;
    throw error;
  }

  const templateStatus = String(template.status || '').toUpperCase();
  if (!['APPROVED', 'ACTIVE'].includes(templateStatus)) {
    const error = new Error('Somente templates aprovados podem ser enviados.');
    error.status = 400;
    throw error;
  }

  const contacts = await db.collection('contacts')
    .find({ tenantId, id: { $in: uniqueContactIds } })
    .toArray();
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  const now = new Date().toISOString();
  const campaignId = createCampaignId();
  const items = uniqueContactIds.map((contactId, index) => {
    const contact = contactsById.get(contactId) || null;
    if (!contact) {
      return {
        id: generateId('campaign_item'),
        tenantId,
        campaignId,
        contactId,
        turizmoLeadId: turizmoLeadByContactId?.[contactId] || null,
        turizmoCompanyId: turizmoCompanyByContactId?.[contactId] || null,
        sortIndex: index,
        contactName: 'Contato removido',
        phoneEntryId: null,
        phoneNumber: null,
        status: 'failed',
        error: 'Contato nao encontrado neste tenant.',
        processedAt: now,
        outreachId: null,
        chatId: null,
        providerMessageId: null,
        to: null,
        templateId: template.id,
        deliveryStatus: null,
        sentAt: null,
        deliveredAt: null,
        readAt: null,
        repliedAt: null,
        firstResponseTimeMs: null,
        classificationId: null,
        intent: null,
        sentiment: null,
        confidence: null,
        nextAction: null,
        optedOutAt: null,
        failureCode: 'contact_not_found',
        failureReason: 'Contato nao encontrado neste tenant.'
      };
    }

    const phoneEntry = resolveContactWhatsAppPhone(contact);
    if (!phoneEntry?.number) {
      return {
        id: generateId('campaign_item'),
        tenantId,
        campaignId,
        contactId: contact.id,
        turizmoLeadId: turizmoLeadByContactId?.[contact.id] || null,
        turizmoCompanyId: turizmoCompanyByContactId?.[contact.id] || null,
        sortIndex: index,
        contactName: contact.name || 'Sem nome',
        phoneEntryId: null,
        phoneNumber: null,
        status: 'failed',
        error: 'Contato sem numero de WhatsApp disponivel.',
        processedAt: now,
        outreachId: null,
        chatId: null,
        providerMessageId: null,
        to: null,
        templateId: template.id,
        deliveryStatus: null,
        sentAt: null,
        deliveredAt: null,
        readAt: null,
        repliedAt: null,
        firstResponseTimeMs: null,
        classificationId: null,
        intent: null,
        sentiment: null,
        confidence: null,
        nextAction: null,
        optedOutAt: null,
        failureCode: 'missing_phone',
        failureReason: 'Contato sem numero de WhatsApp disponivel.'
      };
    }

    return {
      id: generateId('campaign_item'),
      tenantId,
      campaignId,
      contactId: contact.id,
      turizmoLeadId: turizmoLeadByContactId?.[contact.id] || null,
      turizmoCompanyId: turizmoCompanyByContactId?.[contact.id] || null,
      sortIndex: index,
      contactName: contact.name || 'Sem nome',
      phoneEntryId: phoneEntry.id || null,
      phoneNumber: phoneEntry.number,
      templateId: template.id,
      status: scheduledAt ? 'scheduled' : 'pending',
      deliveryStatus: null,
      error: null,
      processedAt: null,
      outreachId: null,
      chatId: null,
      providerMessageId: null,
      to: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      repliedAt: null,
      firstResponseTimeMs: null,
      classificationId: null,
      intent: null,
      sentiment: null,
      confidence: null,
      nextAction: null,
      optedOutAt: null,
      failureCode: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now
    };
  });

  const pendingCount = items.filter((item) => ['pending', 'scheduled', 'sending'].includes(item.status)).length;
  const successCount = items.filter((item) => item.status === 'sent').length;
  const failedCount = items.filter((item) => item.status === 'failed').length;

  const baseCampaign = {
    id: campaignId,
    tenantId,
    name: String(name || template.name || 'Campanha').trim(),
    channel: 'whatsapp',
    templateId: template.id,
    templateName: template.name,
    templateLanguage: template.language || null,
    senderPhoneNumberId: sender.phoneNumberId,
    senderLabel: sender.label || sender.displayNumber || null,
    values: sanitizeValues(values),
    cadenceId: cadenceId || null,
    scheduledAt: scheduledAt || null,
    timezone,
    turizmoCampaignId: turizmoCampaignId || null,
    integrationSource: integrationSource || null,
    items: [],
    totalContacts: items.length,
    pendingCount,
    successCount,
    sentCount: successCount,
    deliveredCount: 0,
    readCount: 0,
    repliedCount: 0,
    positiveCount: 0,
    negativeCount: 0,
    neutralCount: 0,
    optOutCount: 0,
    qualifiedCount: 0,
    demoRequestedCount: 0,
    conversionCount: 0,
    failedCount,
    processedCount: items.length - pendingCount,
    progressPercent: items.length ? Math.round(((items.length - pendingCount) / items.length) * 100) : 0,
    status: cadenceId || scheduledAt ? 'scheduled' : (pendingCount > 0 ? 'pending' : (failedCount > 0 ? 'failed' : 'completed')),
    createdBy: {
      id: actor?.id || null,
      name: actor?.name || 'Usuario',
      role: actor?.role || null
    },
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null
  };

  const campaign = normalizeCampaign(baseCampaign);
  if (campaign.pendingCount === 0) {
    campaign.startedAt = now;
    campaign.finishedAt = now;
  }

  await db.collection(COLLECTION).insertOne(campaign);
  for (const item of items) {
    await db.collection(ITEM_COLLECTION).insertOne({
      ...item,
      campaignId,
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now
    });
  }
  if (cadenceId) {
    for (const item of items.filter((entry) => entry.contactId && !entry.failureCode)) {
      await enrollContactInCadence({
        tenantId,
        cadenceId,
        campaignId,
        campaignItemId: item.id,
        contactId: item.contactId,
        turizmoLeadId: item.turizmoLeadId,
        startAt: scheduledAt
      });
    }
  }
  const createdEvent = await enqueueTurizmoEvent(createTurizmoEvent({
    tenantId,
    type: 'campaign.created',
    aggregateType: 'campaign',
    aggregateId: campaignId,
    idempotencyKey: `campaign-created:${campaignId}`,
    data: {
      campaignId,
      turizmoCampaignId: baseCampaign.turizmoCampaignId,
      name: baseCampaign.name,
      templateId: template.id,
      totalContacts: items.length,
      createdAt: now
    }
  }));
  if (createdEvent) enqueueTurizmoDelivery({ outboxId: createdEvent.id }).catch(() => {});
  emitCampaignUpdate(campaign, 'campaign_created');
  await createLog('CONTACT_OUTREACH_CAMPAIGN_CREATE', {
    tenantId,
    campaignId: campaign.id,
    totalContacts: campaign.totalContacts,
    successCount: campaign.successCount,
    failedCount: campaign.failedCount,
    templateId: template.id,
    templateName: template.name,
    senderPhoneNumberId: sender.phoneNumberId
  }, actor?.id || null);

  return campaign;
};

const updateCampaign = async (db, campaign) => {
  const normalized = normalizeCampaign({
    ...campaign,
    updatedAt: new Date().toISOString()
  });

  if (normalized.pendingCount > 0 && !normalized.startedAt) {
    normalized.startedAt = new Date().toISOString();
  }
  if (normalized.pendingCount === 0 && !normalized.finishedAt) {
    normalized.finishedAt = new Date().toISOString();
  }

  await db.collection(COLLECTION).updateOne(
    { id: normalized.id },
    { $set: normalized }
  );

  emitCampaignUpdate(normalized);
  return normalized;
};

const refreshCampaignFromItems = async (db, campaign) => {
  const [totalContacts, pendingCount, successCount, failedCount] = await Promise.all([
    db.collection(ITEM_COLLECTION).countDocuments({ tenantId: campaign.tenantId, campaignId: campaign.id }),
    db.collection(ITEM_COLLECTION).countDocuments({ tenantId: campaign.tenantId, campaignId: campaign.id, status: { $in: ['pending', 'scheduled', 'sending'] } }),
    db.collection(ITEM_COLLECTION).countDocuments({ tenantId: campaign.tenantId, campaignId: campaign.id, status: { $in: ['sent', 'delivered', 'read', 'replied', 'classified', 'qualified'] } }),
    db.collection(ITEM_COLLECTION).countDocuments({ tenantId: campaign.tenantId, campaignId: campaign.id, status: 'failed' })
  ]);
  const processedCount = Math.max(0, totalContacts - pendingCount);
  let status = 'pending';
  if (pendingCount > 0 && processedCount > 0) {
    status = 'processing';
  } else if (pendingCount === 0 && successCount > 0 && failedCount > 0) {
    status = 'completed_with_errors';
  } else if (pendingCount === 0 && failedCount > 0) {
    status = 'failed';
  } else if (pendingCount === 0) {
    status = 'completed';
  }
  // Pausa (manual ou por qualidade) ou cancelamento que chegou durante o envio
  // nao pode ser sobrescrito pelo recalculo de status.
  const atual = await db.collection(COLLECTION).findOne({ tenantId: campaign.tenantId, id: campaign.id });
  if (pendingCount > 0 && ['paused', 'cancelled'].includes(atual?.status)) {
    status = atual.status;
  }
  const now = new Date().toISOString();
  const normalized = {
    ...campaign,
    ...(atual ? { qualityPause: atual.qualityPause ?? null, qualityAck: atual.qualityAck ?? [] } : {}),
    items: [],
    totalContacts,
    pendingCount,
    successCount,
    sentCount: successCount,
    failedCount,
    processedCount,
    progressPercent: totalContacts ? Math.round((processedCount / totalContacts) * 100) : 0,
    status,
    startedAt: campaign.startedAt || (processedCount > 0 ? now : campaign.startedAt || null),
    finishedAt: pendingCount === 0 ? (campaign.finishedAt || now) : null,
    updatedAt: now
  };

  await db.collection(COLLECTION).updateOne(
    { id: normalized.id },
    { $set: normalized }
  );
  emitCampaignUpdate(normalized);
  return normalized;
};

const processCampaignItem = async (campaign, item) => {
  try {
    if (await isContactSuppressed({ tenantId: campaign.tenantId, channel: 'whatsapp', identifier: item.phoneNumber })) {
      return {
        ...item,
        status: 'suppressed',
        error: null,
        failureCode: null,
        failureReason: 'Contato suprimido antes do envio.',
        processedAt: new Date().toISOString()
      };
    }
    const quota = await consumeOutreachQuota({ tenantId: campaign.tenantId, senderPhoneNumberId: campaign.senderPhoneNumberId });
    if (!quota.allowed) {
      return {
        ...item,
        status: 'pending',
        nextAttemptAt: quota.retryAt,
        failureReason: `Envio adiado por ${quota.reason}.`,
        updatedAt: new Date().toISOString()
      };
    }
    await waitOutreachJitter();
    const result = await performWhatsAppContactOutreach({
      tenantId: campaign.tenantId,
      contact: null,
      phoneEntryId: item.phoneEntryId,
      templateId: campaign.templateId,
      senderPhoneNumberId: campaign.senderPhoneNumberId,
      values: campaign.values,
      actor: campaign.createdBy,
      contactId: item.contactId,
      deferHumanAttendance: true
    });

    const sentAt = new Date().toISOString();
    if (result?.outreach?.id) {
      await adapter.updateOne('contactOutreachHistory', { id: result.outreach.id }, {
        $set: {
          campaignId: campaign.id,
          campaignItemId: item.id,
          turizmoLeadId: item.turizmoLeadId || null,
          updatedAt: sentAt
        }
      });
    }
    const event = await enqueueTurizmoEvent(createTurizmoEvent({
      tenantId: campaign.tenantId,
      type: 'message.sent',
      aggregateType: 'campaignItem',
      aggregateId: item.id,
      idempotencyKey: `message-sent:${result?.providerMessageId || item.id}`,
      data: {
        campaignId: campaign.id, turizmoCampaignId: campaign.turizmoCampaignId || null,
        campaignItemId: item.id, outreachId: result?.outreach?.id || null,
        contactId: item.contactId, turizmoLeadId: item.turizmoLeadId || null,
        providerMessageId: result?.providerMessageId || null, sentAt
      }
    }));
    if (event) enqueueTurizmoDelivery({ outboxId: event.id }).catch(() => {});
    return {
      ...item,
      status: 'sent',
      deliveryStatus: 'sent',
      error: null,
      processedAt: sentAt,
      sentAt,
      outreachId: result?.outreach?.id || null,
      chatId: result?.chat?.id || null,
      providerMessageId: result?.providerMessageId || null,
      to: result?.to || null
    };
  } catch (error) {
    return {
      ...item,
      status: 'failed',
      error: error.message || 'Falha ao enviar template',
      failureCode: String(error?.code || error?.status || 'send_failed'),
      failureReason: String(error.message || 'Falha ao enviar template').slice(0, 500),
      processedAt: new Date().toISOString()
    };
  }
};

export const processNextOutreachCampaign = async () => {
  if (workerBusy) return null;
  workerBusy = true;

  try {
    const db = await ensureDb();
    const rows = await db.collection(COLLECTION)
      .find({ status: { $in: PROCESSABLE_STATUSES } })
      .sort({ createdAt: 1 })
      .limit(1)
      .toArray();
    const campaign = rows[0] || null;
    if (!campaign) return { idle: true };

    const pausadaPorCobranca = await pauseCampaignIfBillingBlocked(campaign).catch((error) => {
      console.warn('[OUTREACH CAMPAIGN] Falha ao conferir cobranca:', error.message);
      return null;
    });
    if (pausadaPorCobranca) return { paused: true, reason: 'billing_blocked', campaignId: campaign.id };

    const pausadaPorQualidade = await checkCampaignQuality(campaign).catch((error) => {
      console.warn('[OUTREACH CAMPAIGN] Falha ao conferir qualidade:', error.message);
      return null;
    });
    if (pausadaPorQualidade) return { paused: true, reason: 'quality_guard', campaignId: campaign.id };

      const pendingItem = await db.collection(ITEM_COLLECTION)
      .find({
        tenantId: campaign.tenantId,
        campaignId: campaign.id,
        status: 'pending',
        $or: [
          { nextAttemptAt: { $exists: false } },
          { nextAttemptAt: null },
          { nextAttemptAt: { $lte: new Date().toISOString() } }
        ]
      })
      .sort({ createdAt: 1, sortIndex: 1 })
      .limit(1)
      .toArray();
    if (pendingItem?.[0]) {
      const processedItem = await processCampaignItem(campaign, pendingItem[0]);
      await db.collection(ITEM_COLLECTION).updateOne(
        { id: pendingItem[0].id },
        {
          $set: {
            ...processedItem,
            updatedAt: new Date().toISOString()
          }
        }
      );
      const wasNotStarted = !campaign.startedAt;
      const updated = await refreshCampaignFromItems(db, {
        ...campaign,
        status: 'processing',
        startedAt: campaign.startedAt || new Date().toISOString()
      });
      if (wasNotStarted) await emitCampaignIntegrationEvent(updated, 'campaign.started');

      if (updated.pendingCount === 0) {
        await emitCampaignIntegrationEvent(updated, 'campaign.completed');
        await createLog('CONTACT_OUTREACH_CAMPAIGN_FINISH', {
          tenantId: updated.tenantId,
          campaignId: updated.id,
          totalContacts: updated.totalContacts,
          successCount: updated.successCount,
          failedCount: updated.failedCount,
          status: updated.status
        }, updated.createdBy?.id || null);
      }

      return updated;
    }

    const separateCount = await db.collection(ITEM_COLLECTION).countDocuments({
      tenantId: campaign.tenantId,
      campaignId: campaign.id
    });
    if (separateCount > 0) {
      const updated = await refreshCampaignFromItems(db, campaign);
      const futureItems = await db.collection(ITEM_COLLECTION)
        .find({ tenantId: campaign.tenantId, campaignId: campaign.id, status: 'pending', nextAttemptAt: { $gt: new Date().toISOString() } })
        .sort({ nextAttemptAt: 1 })
        .limit(1)
        .toArray();
      if (futureItems[0]?.nextAttemptAt) {
        return { ...updated, deferred: true, deferredUntil: futureItems[0].nextAttemptAt };
      }
      return updated;
    }

    const pendingIndex = (Array.isArray(campaign.items) ? campaign.items : []).findIndex((item) => item.status === 'pending');
    if (pendingIndex === -1) {
      return await updateCampaign(db, campaign);
    }

    const nextItems = [...campaign.items];
    nextItems[pendingIndex] = await processCampaignItem(campaign, nextItems[pendingIndex]);

    const updated = await updateCampaign(db, {
      ...campaign,
      items: nextItems,
      status: 'processing',
      startedAt: campaign.startedAt || new Date().toISOString()
    });

    if (updated.pendingCount === 0) {
      await emitCampaignIntegrationEvent(updated, 'campaign.completed');
      await createLog('CONTACT_OUTREACH_CAMPAIGN_FINISH', {
        tenantId: updated.tenantId,
        campaignId: updated.id,
        totalContacts: updated.totalContacts,
        successCount: updated.successCount,
        failedCount: updated.failedCount,
        status: updated.status
      }, updated.createdBy?.id || null);
    }

    return updated;
  } finally {
    workerBusy = false;
  }
};

export const startOutreachCampaignWorker = ({ intervalMs = DEFAULT_INTERVAL_MS } = {}) => {
  if (workerTimer) return workerTimer;

  const baseInterval = Math.max(Number(intervalMs) || DEFAULT_INTERVAL_MS, 1500);
  const scheduleNext = (delayMs) => {
    workerTimer = setTimeout(async () => {
      try {
        const result = await processNextOutreachCampaign();
        if (result?.idle) {
          workerIdleDelayMs = Math.min(
            Math.max(workerIdleDelayMs * 1.5, IDLE_INTERVAL_MS),
            MAX_IDLE_INTERVAL_MS
          );
          scheduleNext(workerIdleDelayMs);
          return;
        }

        workerIdleDelayMs = Math.max(baseInterval, IDLE_INTERVAL_MS);
        scheduleNext(baseInterval);
      } catch (error) {
        console.error('[OUTREACH CAMPAIGN] Worker error:', error.message);
        scheduleNext(Math.min(MAX_IDLE_INTERVAL_MS, Math.max(baseInterval * 2, IDLE_INTERVAL_MS)));
      }
    }, delayMs);

    if (typeof workerTimer?.unref === 'function') {
      workerTimer.unref();
    }
  };

  scheduleNext(baseInterval);
  return workerTimer;
};

export const wakeOutreachCampaignWorker = () => {
  workerIdleDelayMs = Math.max(DEFAULT_INTERVAL_MS, IDLE_INTERVAL_MS);
  if (workerTimer) {
    clearTimeout(workerTimer);
    workerTimer = null;
  }
  return startOutreachCampaignWorker({ intervalMs: DEFAULT_INTERVAL_MS });
};

export const stopOutreachCampaignWorker = () => {
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
  workerBusy = false;
};

export const isOutreachCampaignWorkerActive = () => Boolean(workerTimer);

export const releaseDueScheduledCampaigns = async () => {
  const db = await ensureDb();
  const now = nowIso();
  const due = await db.collection(COLLECTION)
    .find({ status: 'scheduled', cadenceId: null, scheduledAt: { $lte: now } }, { projection: { id: 1, tenantId: 1 } })
    .sort({ scheduledAt: 1 })
    .limit(100)
    .toArray();
  for (const campaign of due) {
    await db.collection(ITEM_COLLECTION).updateMany(
      { tenantId: campaign.tenantId, campaignId: campaign.id, status: 'scheduled' },
      { $set: { status: 'pending', updatedAt: now } }
    );
    await db.collection(COLLECTION).updateOne(
      { tenantId: campaign.tenantId, id: campaign.id, status: 'scheduled' },
      { $set: { status: 'pending', updatedAt: now } }
    );
  }
  return due;
};
