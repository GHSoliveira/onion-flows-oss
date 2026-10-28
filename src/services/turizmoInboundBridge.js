import { z } from 'zod';
import adapter from '../../db/DatabaseAdapter.js';
import { generateId } from '../utils/helpers.js';
import {
  buildIdentity,
  identitiesFromLegacyPhones,
  normalizeIdentities,
  phonesFromIdentities
} from '../utils/channelIdentity.js';
import {
  createOutreachCampaign,
  getOutreachCampaignMaxContacts,
  validateOutreachCampaignContactLimit,
  wakeOutreachCampaignWorker
} from './outreachCampaignWorker.js';
import { resolveContactWhatsAppPhone } from './contactOutreach.js';
import { isContactSuppressed } from './contactSuppression.js';
import { enqueueCampaignProcessing } from '../queues/campaignQueue.js';
import { isBullMqEnabled } from './redisClient.js';
import { createDomainId, nowIso, stableHash } from './outreachDomain.js';
import { withLock } from './chatLocks.js';
import { DEFAULT_POST_HANDOFF, normalizePostHandoff } from './protectedAttendance.js';

const INBOUND_COLLECTION = 'integrationInboundRequests';
const DESTINATION = 'turizmo_inbound';
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const bridgeError = (status, code, message, details = null) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details) error.details = details;
  return error;
};

const validateSafeValue = (value, ctx, path = [], depth = 0) => {
  if (depth > 6) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Estrutura excede a profundidade permitida.' });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Array excede o limite permitido.' });
    value.forEach((item, index) => validateSafeValue(item, ctx, [...path, index], depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, key], message: 'Chave nao permitida.' });
      continue;
    }
    if (key.length > 100) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, key], message: 'Chave muito longa.' });
    validateSafeValue(child, ctx, [...path, key], depth + 1);
  }
};

const safeValuesSchema = z.record(z.string().min(1).max(100), z.unknown())
  .superRefine((value, ctx) => {
    validateSafeValue(value, ctx);
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 64 * 1024) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Valores excedem 64 KB.' });
    }
  });

const metadataSchema = z.object({
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(80).optional(),
  segment: z.string().trim().max(160).optional(),
  mapsUrl: z.string().url().max(2048).optional()
}).strict().default({});

const inboundContactSchema = z.object({
  turizmoLeadId: z.string().trim().min(1).max(160),
  turizmoCompanyId: z.string().trim().min(1).max(160).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(8).max(32),
  company: z.string().trim().max(200).optional(),
  email: z.string().email().max(254).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(25).default([]),
  source: z.literal('tes_maps').default('tes_maps'),
  sourcePlaceId: z.string().trim().max(300).nullable().optional(),
  metadata: metadataSchema.optional()
}).strict();

export const turizmoContactsUpsertSchema = z.object({
  tenantId: z.string().trim().min(1).max(160),
  batchId: z.string().trim().min(1).max(200),
  contacts: z.array(inboundContactSchema).min(1).max(1000)
}).strict();

export const turizmoPostHandoffSchema = z.object({
  autoClose: z.literal(false).default(false),
  holdHours: z.number().int().min(1).max(168).default(DEFAULT_POST_HANDOFF.holdHours),
  inboundDuringHold: z.literal('notify_turizmo').default('notify_turizmo'),
  closureMode: z.literal('manual').default('manual')
}).strict().default(DEFAULT_POST_HANDOFF);

export const turizmoCampaignCreateSchema = z.object({
  tenantId: z.string().trim().min(1).max(160),
  turizmoCampaignId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(160),
  channel: z.literal('whatsapp').default('whatsapp'),
  templateId: z.string().trim().min(1).max(200),
  senderPhoneNumberId: z.string().trim().min(1).max(200).nullable().optional(),
  turizmoLeadIds: z.array(z.string().trim().min(1).max(160)).min(1).max(1000),
  values: safeValuesSchema.optional().default({}),
  cadenceId: z.string().trim().min(1).max(200).nullable().optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  timezone: z.string().trim().min(1).max(80).default('America/Sao_Paulo'),
  automationManagedBy: z.enum(['turizmo', 'onion']).default('turizmo'),
  journeyVersion: z.number().int().positive().default(1),
  postHandoff: turizmoPostHandoffSchema
}).strict();

export const turizmoInboundTestSchema = z.object({
  tenantId: z.string().trim().min(1).max(160)
}).strict();

export const normalizeTurizmoWhatsAppPhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15 || digits.startsWith('0')) return null;
  return digits;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};

const requestHash = (payload) => stableHash(JSON.stringify(canonicalize(payload)));

export const ensureTurizmoTenant = async (tenantId) => {
  const tenant = await adapter.findOne('tenants', { id: tenantId });
  if (!tenant || String(tenant.status || 'active').toLowerCase() === 'deleted') {
    throw bridgeError(404, 'tenant_not_found', 'Tenant nao encontrado.');
  }
  return tenant;
};

const executeTurizmoInboundIdempotentUnlocked = async ({
  tenantId,
  idempotencyKey,
  operation,
  operationId,
  payload,
  execute
}) => {
  const normalizedKey = String(idempotencyKey || '').trim();
  if (!normalizedKey || normalizedKey.length > 500) {
    throw bridgeError(400, 'idempotency_key_required', 'Idempotency-Key e obrigatoria.');
  }
  const operationKey = `${operation}:${operationId}`;
  const hash = requestHash(payload);
  const query = {
    tenantId,
    destination: DESTINATION,
    $or: [{ idempotencyKey: normalizedKey }, { operationKey }]
  };
  let existing = await adapter.findOne(INBOUND_COLLECTION, query);
  if (existing) {
    if (existing.requestHash !== hash) {
      throw bridgeError(409, 'idempotency_conflict', 'A chave idempotente ja foi usada com outro payload.');
    }
    if (existing.status === 'completed' && existing.response) {
      return { replayed: true, statusCode: Number(existing.statusCode || 200), result: existing.response };
    }
    if (existing.status === 'processing') {
      throw bridgeError(409, 'idempotency_in_progress', 'A operacao idempotente ainda esta em processamento.');
    }
    await adapter.updateOne(INBOUND_COLLECTION, { id: existing.id }, {
      $set: { status: 'processing', lastError: null, updatedAt: nowIso() }
    });
  } else {
    existing = {
      id: createDomainId('inbound'),
      tenantId,
      destination: DESTINATION,
      operation,
      operationId,
      operationKey,
      idempotencyKey: normalizedKey,
      requestHash: hash,
      status: 'processing',
      response: null,
      statusCode: null,
      lastError: null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    try {
      await adapter.insertOne(INBOUND_COLLECTION, existing);
    } catch (error) {
      if (String(error?.code) !== '11000') throw error;
      const raced = await adapter.findOne(INBOUND_COLLECTION, query);
      if (raced?.requestHash === hash && raced?.status === 'completed') {
        return { replayed: true, statusCode: Number(raced.statusCode || 200), result: raced.response };
      }
      throw bridgeError(409, 'idempotency_in_progress', 'A operacao idempotente ja foi recebida.');
    }
  }

  try {
    const execution = await execute();
    const statusCode = Number(execution?.statusCode || 200);
    const result = execution?.result ?? execution;
    await adapter.updateOne(INBOUND_COLLECTION, { id: existing.id }, {
      $set: { status: 'completed', response: result, statusCode, completedAt: nowIso(), updatedAt: nowIso() }
    });
    return { replayed: false, statusCode, result };
  } catch (error) {
    await adapter.updateOne(INBOUND_COLLECTION, { id: existing.id }, {
      $set: {
        status: 'failed',
        lastError: { code: String(error?.code || 'integration_failed').slice(0, 80), message: String(error?.message || 'Falha na integracao').slice(0, 300) },
        updatedAt: nowIso()
      }
    });
    throw error;
  }
};

export const executeTurizmoInboundIdempotent = async (args) => {
  const tenantId = String(args?.tenantId || '').trim();
  const operation = String(args?.operation || '').trim();
  const operationId = String(args?.operationId || '').trim();
  const lockKey = tenantId && operation && operationId
    ? `turizmo-inbound:${tenantId}:${operation}:${operationId}`
    : null;
  return withLock(lockKey, () => executeTurizmoInboundIdempotentUnlocked(args));
};

const identitiesForContact = (contact) => {
  const explicit = Array.isArray(contact?.channelIdentities) ? contact.channelIdentities : [];
  return explicit.length ? explicit : identitiesFromLegacyPhones(contact?.phones || []);
};

const findContactByPhone = async (tenantId, normalizedPhone) => {
  let contact = await adapter.findOne('contacts', { tenantId, normalizedPrimaryPhone: normalizedPhone });
  if (contact) return contact;
  contact = await adapter.findOne('contacts', {
    tenantId,
    'channelIdentities.channel': 'whatsapp',
    'channelIdentities.normalizedIdentifier': normalizedPhone
  });
  if (contact) return contact;
  contact = await adapter.findOne('contacts', { tenantId, 'phones.normalizedNumber': normalizedPhone });
  if (contact) return contact;

  // Compatibilidade com adapters documentais que nao consultam arrays aninhados.
  const candidates = await adapter.findMany('contacts', { query: { tenantId }, limit: 100000 });
  return candidates.find((candidate) => identitiesForContact(candidate).some((identity) => (
    identity?.channel === 'whatsapp'
      && String(identity.normalizedIdentifier || identity.identifier || '').replace(/\D/g, '') === normalizedPhone
  ))) || null;
};

const mergedContactIdentities = (existing, normalizedPhone, name) => {
  const current = identitiesForContact(existing).map((identity) => ({ ...identity, isPrimary: false }));
  const matching = current.find((identity) => identity.channel === 'whatsapp'
    && String(identity.normalizedIdentifier || identity.identifier || '').replace(/\D/g, '') === normalizedPhone);
  const identity = buildIdentity({
    channel: 'whatsapp',
    rawIdentifier: normalizedPhone,
    displayName: name,
    isPrimary: true,
    existing: matching || null
  });
  const preserved = current.filter((entry) => entry.id !== matching?.id);
  return normalizeIdentities([identity, ...preserved]);
};

const upsertOneContact = async ({ tenantId, item }) => {
  const normalizedPhone = normalizeTurizmoWhatsAppPhone(item.phone);
  if (!normalizedPhone) throw bridgeError(400, 'invalid_phone', 'Telefone invalido para WhatsApp.');

  const [byLead, byPhone] = await Promise.all([
    adapter.findOne('contacts', { tenantId, turizmoLeadId: item.turizmoLeadId }),
    findContactByPhone(tenantId, normalizedPhone)
  ]);
  if (byLead && byPhone && byLead.id !== byPhone.id) {
    throw bridgeError(409, 'contact_identity_conflict', 'Lead e telefone pertencem a contatos diferentes.');
  }

  const existing = byLead || byPhone || null;
  if (existing?.turizmoLeadId && existing.turizmoLeadId !== item.turizmoLeadId) {
    throw bridgeError(409, 'contact_identity_conflict', 'Telefone ja esta vinculado a outro lead do Turizmo.');
  }

  const now = nowIso();
  const channelIdentities = mergedContactIdentities(existing, normalizedPhone, item.name);
  const tags = [...new Set([...(Array.isArray(existing?.tags) ? existing.tags : []), ...item.tags])];
  const patch = {
    name: item.name,
    company: item.company !== undefined ? (item.company || null) : (existing?.company || null),
    email: item.email !== undefined ? (item.email || null) : (existing?.email || null),
    tags,
    phones: phonesFromIdentities(channelIdentities),
    channelIdentities,
    primaryChannel: 'whatsapp',
    primaryIdentifier: normalizedPhone,
    primaryPhone: normalizedPhone,
    normalizedPrimaryPhone: normalizedPhone,
    turizmoLeadId: item.turizmoLeadId,
    turizmoCompanyId: item.turizmoCompanyId !== undefined
      ? (item.turizmoCompanyId || null)
      : (existing?.turizmoCompanyId || null),
    integrationSource: 'turizmo',
    integrationUpdatedAt: now,
    leadSource: item.source,
    sourcePlaceId: item.sourcePlaceId !== undefined
      ? (item.sourcePlaceId || null)
      : (existing?.sourcePlaceId || null),
    integrationMetadata: item.metadata !== undefined
      ? item.metadata
      : (existing?.integrationMetadata || {}),
    updatedBy: 'integration:turizmo',
    updatedAt: now
  };

  if (existing) {
    await adapter.updateOne('contacts', { tenantId, id: existing.id }, { $set: patch });
    return { contactId: existing.id, status: 'updated' };
  }

  const contact = {
    id: generateId('contact'),
    tenantId,
    agentDefinedName: null,
    notes: null,
    ...patch,
    createdBy: 'integration:turizmo',
    createdAt: now
  };
  await adapter.insertOne('contacts', contact);
  return { contactId: contact.id, status: 'created' };
};

export const upsertTurizmoContacts = async ({ tenantId, batchId, contacts }) => {
  await ensureTurizmoTenant(tenantId);
  if (contacts.length > getOutreachCampaignMaxContacts()) {
    throw bridgeError(400, 'campaign_contact_limit_exceeded', 'O lote excede o limite permitido de contatos.');
  }

  const items = [];
  let createdCount = 0;
  let updatedCount = 0;
  for (let index = 0; index < contacts.length; index += 1) {
    const item = contacts[index];
    const result = await upsertOneContact({ tenantId, item });
    if (result.status === 'created') createdCount += 1;
    if (result.status === 'updated') updatedCount += 1;
    items.push({
      index,
      turizmoLeadId: item.turizmoLeadId,
      turizmoCompanyId: item.turizmoCompanyId || null,
      contactId: result.contactId,
      status: result.status,
      errorCode: null,
      message: null
    });
  }

  return {
    ok: true,
    tenantId,
    batchId,
    requested: contacts.length,
    createdCount,
    updatedCount,
    skippedCount: 0,
    failedCount: 0,
    items
  };
};

const resolveCampaignContacts = async ({ tenantId, turizmoLeadIds }) => {
  const uniqueLeadIds = [...new Set(turizmoLeadIds)];
  validateOutreachCampaignContactLimit(uniqueLeadIds);
  const contacts = await adapter.findMany('contacts', {
    query: { tenantId, turizmoLeadId: { $in: uniqueLeadIds } },
    limit: getOutreachCampaignMaxContacts()
  });
  const byLead = new Map(contacts.map((contact) => [contact.turizmoLeadId, contact]));
  const missingTurizmoLeadIds = uniqueLeadIds.filter((leadId) => !byLead.has(leadId));
  if (missingTurizmoLeadIds.length) {
    throw bridgeError(404, 'turizmo_leads_not_synced', 'Existem leads ainda nao sincronizados no Onion.', { missingTurizmoLeadIds });
  }

  const suppressedTurizmoLeadIds = [];
  for (const leadId of uniqueLeadIds) {
    const contact = byLead.get(leadId);
    const phone = resolveContactWhatsAppPhone(contact);
    if (!phone?.number) throw bridgeError(400, 'contact_without_whatsapp', 'Contato sincronizado sem telefone WhatsApp valido.');
    if (await isContactSuppressed({ tenantId, channel: 'whatsapp', identifier: phone.number })) {
      suppressedTurizmoLeadIds.push(leadId);
    }
  }
  if (suppressedTurizmoLeadIds.length) {
    throw bridgeError(400, 'contacts_suppressed', 'Existem contatos suprimidos ou em opt-out.', { suppressedTurizmoLeadIds });
  }
  return uniqueLeadIds.map((leadId) => byLead.get(leadId));
};

export const createTurizmoCampaign = async ({ payload, actor }) => {
  const { tenantId, turizmoCampaignId } = payload;
  await ensureTurizmoTenant(tenantId);
  const existing = await adapter.findOne('outreachCampaigns', { tenantId, turizmoCampaignId });
  if (existing) return { campaign: existing, duplicate: true };

  if (payload.cadenceId) {
    const cadence = await adapter.findOne('cadences', { tenantId, id: payload.cadenceId });
    if (!cadence) throw bridgeError(404, 'cadence_not_found', 'Cadencia nao encontrada.');
  }
  const contacts = await resolveCampaignContacts({ tenantId, turizmoLeadIds: payload.turizmoLeadIds });
  const contactIds = contacts.map((contact) => contact.id);
  const turizmoLeadByContactId = Object.fromEntries(contacts.map((contact) => [contact.id, contact.turizmoLeadId]));
  const turizmoCompanyByContactId = Object.fromEntries(
    contacts.filter((contact) => contact.turizmoCompanyId).map((contact) => [contact.id, contact.turizmoCompanyId])
  );

  const campaign = await createOutreachCampaign({
    tenantId,
    name: payload.name,
    channel: payload.channel,
    contactIds,
    templateId: payload.templateId,
    senderPhoneNumberId: payload.senderPhoneNumberId || null,
    values: payload.values || {},
    cadenceId: payload.cadenceId || null,
    scheduledAt: payload.scheduledAt || null,
    timezone: payload.timezone,
    turizmoLeadByContactId,
    turizmoCompanyByContactId,
    turizmoCampaignId,
    integrationSource: 'turizmo',
    actor
  });
  campaign.automationManagedBy = payload.automationManagedBy;
  campaign.journeyVersion = payload.journeyVersion;
  campaign.postHandoff = normalizePostHandoff(payload.postHandoff);
  await adapter.updateOne('outreachCampaigns', { tenantId, id: campaign.id }, {
    $set: {
      automationManagedBy: payload.automationManagedBy,
      journeyVersion: payload.journeyVersion,
      postHandoff: campaign.postHandoff,
      updatedAt: nowIso()
    }
  });

  for (const contact of contacts) {
    const existingState = await adapter.findOne('turizmoAutomationStates', {
      tenantId,
      turizmoLeadId: contact.turizmoLeadId
    });
    const stateUpdatedAt = nowIso();
    await adapter.updateOne('turizmoAutomationStates', {
      tenantId,
      turizmoLeadId: contact.turizmoLeadId
    }, {
      $set: {
        tenantId,
        turizmoLeadId: contact.turizmoLeadId,
        campaignId: campaign.id,
        turizmoCampaignId,
        postHandoff: campaign.postHandoff,
        updatedAt: stateUpdatedAt
      },
      $setOnInsert: {
        id: createDomainId('turizmo_state'),
        automationLocked: false,
        createdAt: stateUpdatedAt
      }
    }, { upsert: true });
  }

  if (!payload.cadenceId && !payload.scheduledAt) {
    const job = isBullMqEnabled()
      ? await enqueueCampaignProcessing({ campaignId: campaign.id, reason: 'turizmo_inbound_created' })
      : null;
    if (!job) wakeOutreachCampaignWorker();
  }
  return { campaign, duplicate: false };
};

export const campaignBridgeResponse = (campaign, duplicate = false) => ({
  ok: true,
  duplicate,
  tenantId: campaign.tenantId,
  turizmoCampaignId: campaign.turizmoCampaignId,
  onionCampaignId: campaign.id,
  status: campaign.status,
  contactCount: Number(campaign.totalContacts || 0),
  postHandoff: normalizePostHandoff(campaign.postHandoff),
  createdAt: campaign.createdAt
});

export const getTurizmoCampaign = async ({ tenantId, turizmoCampaignId }) => {
  await ensureTurizmoTenant(tenantId);
  const campaign = await adapter.findOne('outreachCampaigns', { tenantId, turizmoCampaignId });
  if (!campaign) return null;
  return {
    tenantId,
    turizmoCampaignId,
    onionCampaignId: campaign.id,
    status: campaign.status,
    totalContacts: Number(campaign.totalContacts || 0),
    sentCount: Number(campaign.sentCount ?? campaign.successCount ?? 0),
    deliveredCount: Number(campaign.deliveredCount || 0),
    readCount: Number(campaign.readCount || 0),
    repliedCount: Number(campaign.repliedCount || 0),
    positiveCount: Number(campaign.positiveCount || 0),
    negativeCount: Number(campaign.negativeCount || 0),
    optedOutCount: Number(campaign.optOutCount || 0),
    failedCount: Number(campaign.failedCount || 0),
    postHandoff: normalizePostHandoff(campaign.postHandoff),
    createdAt: campaign.createdAt,
    startedAt: campaign.startedAt || null,
    finishedAt: campaign.finishedAt || null
  };
};

export const formatBridgeError = (error) => ({
  code: error?.code || 'turizmo_bridge_failed',
  message: Number(error?.status || 500) >= 500 ? 'Falha interna na integracao Turizmo.' : (error?.message || 'Requisicao invalida.'),
  ...(error?.details ? { details: error.details } : {})
});
