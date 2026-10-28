import adapter from '../../db/DatabaseAdapter.js';
import { envFlag, envInt } from '../utils/env.js';
import { withChannelUserLock } from './chatLocks.js';
import { performWhatsAppContactOutreach } from './contactOutreach.js';
import { isContactSuppressed } from './contactSuppression.js';
import { COLLECTIONS, createDomainId, nowIso } from './outreachDomain.js';
import { consumeOutreachQuota, waitOutreachJitter } from './outreachRateLimit.js';
import { createTurizmoEvent, enqueueTurizmoEvent } from './integrationOutbox.js';
import { enqueueTurizmoDelivery } from '../queues/turizmoQueue.js';
import { checkCampaignQuality } from './outreachQualityGuard.js';
import { pauseCampaignIfBillingBlocked } from './billingGuard.js';
import { syncCampaignCounters } from './outreachMetrics.js';

const EXECUTION_ACTIVE = ['scheduled', 'waiting', 'running'];
const POSITIVE_INTENTS = new Set(['positivo', 'pediu_demo', 'pediu_preco', 'pediu_proposta']);
const NEGATIVE_INTENTS = new Set(['negativo', 'objecao_preco', 'objecao_tempo', 'ja_possui_sistema']);

const configuredStepIndex = (value, fallback, stepCount) => {
  const order = Number(value);
  if (!Number.isInteger(order) || order < 1 || order > stepCount) return fallback;
  return order - 1;
};

const nextStepIndexFor = ({ execution, cadence, campaignItem }) => {
  const fallback = execution.currentStep + 1;
  const intent = campaignItem?.intent;
  if (POSITIVE_INTENTS.has(intent)) return configuredStepIndex(cadence.steps?.[execution.currentStep]?.nextStepOnPositive, fallback, cadence.steps?.length || 0);
  if (NEGATIVE_INTENTS.has(intent)) return configuredStepIndex(cadence.steps?.[execution.currentStep]?.nextStepOnNegative, fallback, cadence.steps?.length || 0);
  if (execution.currentStep > 0 && !campaignItem?.repliedAt) {
    return configuredStepIndex(cadence.steps?.[execution.currentStep]?.nextStepOnNoResponse, fallback, cadence.steps?.length || 0);
  }
  return fallback;
};

const matchesStepConditions = (conditions, campaignItem) => {
  if (!conditions) return true;
  if (Array.isArray(conditions)) return conditions.every((condition) => matchesStepConditions(condition, campaignItem));
  if (typeof conditions !== 'object') return true;
  return Object.entries(conditions).every(([field, expected]) => {
    const actual = campaignItem?.[field];
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  });
};

const syncCadenceCampaign = async ({ tenantId, campaignId }) => {
  if (!tenantId || !campaignId) return null;
  const campaign = await adapter.findOne(COLLECTIONS.campaigns, { tenantId, id: campaignId });
  if (!campaign) return null;
  const [executions, items] = await Promise.all([
    adapter.findMany(COLLECTIONS.cadenceExecutions, { query: { tenantId, campaignId }, limit: 100000 }),
    adapter.findMany(COLLECTIONS.campaignItems, { query: { tenantId, campaignId }, limit: 100000 })
  ]);
  const activeCount = executions.filter((item) => EXECUTION_ACTIVE.includes(item.status) || item.status === 'paused').length;
  const failedCount = items.filter((item) => item.status === 'failed').length;
  const sentCount = items.filter((item) => ['sent', 'delivered', 'read', 'replied', 'classified', 'qualified'].includes(item.status)).length;
  const startedAt = campaign.startedAt || (executions.some((item) => item.lastExecutionAt || Number(item.attemptCount || 0) > 0) ? nowIso() : null);
  const terminal = executions.length > 0 && activeCount === 0;
  const keepStatus = !terminal && ['paused', 'cancelled'].includes(campaign.status);
  const status = terminal
    ? (failedCount > 0 ? 'completed_with_errors' : 'completed')
    : (keepStatus ? campaign.status : (startedAt ? 'processing' : 'scheduled'));
  const finishedAt = terminal ? (campaign.finishedAt || nowIso()) : null;
  const updated = {
    status,
    pendingCount: activeCount,
    processedCount: Math.max(0, items.length - activeCount),
    sentCount,
    successCount: sentCount,
    failedCount,
    progressPercent: items.length ? Math.round(((items.length - activeCount) / items.length) * 100) : 0,
    startedAt,
    finishedAt,
    updatedAt: nowIso()
  };
  await adapter.updateOne(COLLECTIONS.campaigns, { tenantId, id: campaignId }, { $set: updated });
  const eventType = terminal ? 'campaign.completed' : (!campaign.startedAt && startedAt ? 'campaign.started' : null);
  if (eventType === 'campaign.completed') {
    const contadores = await syncCampaignCounters({ tenantId, campaignId }).catch(() => null);
    if (contadores) Object.assign(campaign, contadores);
  }
  if (eventType) {
    const event = await enqueueTurizmoEvent(createTurizmoEvent({
      tenantId,
      type: eventType,
      aggregateType: 'campaign',
      aggregateId: campaignId,
      idempotencyKey: `${eventType}:${campaignId}`,
      data: eventType === 'campaign.started'
        ? { campaignId, turizmoCampaignId: campaign.turizmoCampaignId || null, startedAt }
        : {
            campaignId, turizmoCampaignId: campaign.turizmoCampaignId || null, sentCount, failedCount,
            repliedCount: Number(campaign.repliedCount || 0),
            positiveCount: Number(campaign.positiveCount || 0),
            finishedAt
          }
    }));
    if (event) enqueueTurizmoDelivery({ outboxId: event.id }).catch(() => {});
  }
  return { ...campaign, ...updated };
};

const addMinutes = (iso, minutes) => new Date(new Date(iso).getTime() + Math.max(0, Number(minutes || 0)) * 60000).toISOString();

const localParts = (date, timezone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
};

const weekdayNumber = (shortName) => ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[shortName];
const timeNumber = (value) => {
  const [hour, minute] = String(value || '00:00').split(':').map(Number);
  return (hour * 60) + minute;
};

export const isWithinCadenceWindow = (cadence, date = new Date()) => {
  const timezone = cadence?.timezone || 'America/Sao_Paulo';
  const parts = localParts(date, timezone);
  const allowedWeekdays = Array.isArray(cadence?.allowedWeekdays) && cadence.allowedWeekdays.length
    ? cadence.allowedWeekdays.map(Number)
    : [1, 2, 3, 4, 5];
  if (!allowedWeekdays.includes(weekdayNumber(parts.weekday))) return false;
  const current = (Number(parts.hour) * 60) + Number(parts.minute);
  return current >= timeNumber(cadence.allowedStartTime || '08:00')
    && current <= timeNumber(cadence.allowedEndTime || '18:00');
};

const nextWindow = (cadence, from = new Date()) => {
  const candidate = new Date(from);
  for (let offset = 0; offset < 8 * 24 * 4; offset += 1) {
    if (isWithinCadenceWindow(cadence, candidate)) return candidate.toISOString();
    candidate.setMinutes(candidate.getMinutes() + 15);
  }
  return new Date(from.getTime() + 24 * 60 * 60 * 1000).toISOString();
};

export const createCadence = async ({ tenantId, data, actor }) => {
  const now = nowIso();
  const steps = (Array.isArray(data.steps) ? data.steps : [])
    .map((step, index) => ({
      order: index + 1,
      delayMinutes: Math.max(0, Number(step.delayMinutes || 0)),
      action: step.action || 'send_template',
      templateId: step.templateId || null,
      senderPhoneNumberId: step.senderPhoneNumberId || null,
      values: step.values && typeof step.values === 'object' ? step.values : {},
      conditions: step.conditions || null,
      skipIfReplied: step.skipIfReplied !== false,
      skipIfRead: Boolean(step.skipIfRead),
      nextStepOnPositive: step.nextStepOnPositive ?? null,
      nextStepOnNegative: step.nextStepOnNegative ?? null,
      nextStepOnNoResponse: step.nextStepOnNoResponse ?? null
    }));
  const cadence = {
    id: createDomainId('cadence'), tenantId,
    name: String(data.name || '').trim(),
    description: String(data.description || '').trim(),
    status: data.status === 'active' ? 'active' : 'draft',
    steps,
    timezone: data.timezone || 'America/Sao_Paulo',
    allowedWeekdays: data.allowedWeekdays || [1, 2, 3, 4, 5],
    allowedStartTime: data.allowedStartTime || '08:00',
    allowedEndTime: data.allowedEndTime || '18:00',
    stopOnReply: data.stopOnReply !== false,
    stopOnPositive: data.stopOnPositive !== false,
    stopOnNegative: data.stopOnNegative !== false,
    stopOnOptOut: data.stopOnOptOut !== false,
    createdBy: actor?.id || null,
    createdAt: now,
    updatedAt: now
  };
  await adapter.insertOne(COLLECTIONS.cadences, cadence);
  return cadence;
};

export const updateCadence = async ({ tenantId, cadenceId, patch, actor }) => {
  const existing = await adapter.findOne(COLLECTIONS.cadences, { tenantId, id: cadenceId });
  if (!existing) return null;
  const updated = { ...existing, ...patch, id: existing.id, tenantId, updatedBy: actor?.id || null, updatedAt: nowIso() };
  if (Array.isArray(patch.steps)) {
    updated.steps = patch.steps.map((step, index) => ({ ...step, order: index + 1, delayMinutes: Math.max(0, Number(step.delayMinutes || 0)) }));
  }
  await adapter.updateOne(COLLECTIONS.cadences, { id: existing.id }, { $set: updated });
  return updated;
};

export const enrollContactInCadence = async ({ tenantId, cadenceId, campaignId = null, campaignItemId = null, contactId, turizmoLeadId = null, startAt = null }) => {
  const cadence = await adapter.findOne(COLLECTIONS.cadences, { tenantId, id: cadenceId, status: 'active' });
  if (!cadence) throw new Error('Cadencia ativa nao encontrada');
  const existing = await adapter.findOne(COLLECTIONS.cadenceExecutions, { tenantId, cadenceId, campaignItemId, contactId, status: { $in: EXECUTION_ACTIVE } });
  if (existing) return existing;
  const now = nowIso();
  const baseStartAt = startAt && new Date(startAt).getTime() > Date.now() ? startAt : now;
  const firstStep = cadence.steps?.[0] || null;
  const execution = {
    id: createDomainId('cadence_exec'), tenantId, cadenceId, campaignId, campaignItemId,
    contactId, turizmoLeadId, currentStep: 0, status: firstStep ? 'scheduled' : 'completed',
    nextExecutionAt: firstStep ? addMinutes(baseStartAt, firstStep.delayMinutes) : null,
    lastExecutionAt: null, stopReason: null, lockedAt: null, attemptCount: 0,
    createdAt: now, updatedAt: now
  };
  await adapter.insertOne(COLLECTIONS.cadenceExecutions, execution);
  return execution;
};

export const stopCadencesForContact = async ({ tenantId, contactId, reason = 'stopped_by_reply' }) => {
  if (!tenantId || !contactId) return 0;
  const executions = await adapter.findMany(COLLECTIONS.cadenceExecutions, {
    query: { tenantId, contactId, status: { $in: EXECUTION_ACTIVE } }, limit: 1000
  });
  for (const execution of executions) {
    const cadence = await adapter.findOne(COLLECTIONS.cadences, { tenantId, id: execution.cadenceId });
    if (reason === 'stopped_by_reply' && cadence?.stopOnReply === false) continue;
    if (reason === 'stopped_by_positive' && cadence?.stopOnPositive === false) continue;
    if (reason === 'stopped_by_negative' && cadence?.stopOnNegative === false) continue;
    await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: execution.id }, {
      $set: { status: reason, stopReason: reason, nextExecutionAt: null, lockedAt: null, updatedAt: nowIso() }
    });
    await syncCadenceCampaign({ tenantId, campaignId: execution.campaignId });
  }
  return executions.length;
};

const canSendExecution = async ({ execution, cadence, campaignItem }) => {
  if (!campaignItem?.phoneNumber) return { allowed: false, reason: 'missing_phone' };
  if (await isContactSuppressed({ tenantId: execution.tenantId, channel: 'whatsapp', identifier: campaignItem.phoneNumber })) {
    return { allowed: false, reason: 'opted_out' };
  }
  const activeHuman = await adapter.findOne('activeChats', {
    tenantId: execution.tenantId,
    contactId: execution.contactId,
    status: { $in: ['open', 'waiting'] }
  }, { projection: { id: 1 } });
  if (activeHuman) return { allowed: false, reason: 'human_chat_active' };
  const tenant = await adapter.findOne('tenants', { id: execution.tenantId }, { projection: { billingStatus: 1, status: 1 } });
  if (tenant?.billingStatus === 'blocked' || tenant?.status === 'suspended') return { allowed: false, reason: 'tenant_blocked' };
  if (!isWithinCadenceWindow(cadence)) return { allowed: false, reason: 'outside_window', retryAt: nextWindow(cadence) };
  return { allowed: true };
};

export const processNextCadenceExecution = async ({ executionId = null } = {}) => {
  if (!envFlag('CADENCE_ENGINE_ENABLED', false)) return { idle: true, disabled: true };
  const query = executionId
    ? { id: executionId }
    : { status: { $in: ['scheduled', 'waiting'] }, nextExecutionAt: { $lte: nowIso() } };
  const rows = await adapter.findMany(COLLECTIONS.cadenceExecutions, { query, sort: { nextExecutionAt: 1 }, limit: 1 });
  const execution = rows[0];
  if (!execution) return { idle: true };
  return withChannelUserLock({ channel: 'cadence', tenantId: execution.tenantId, userId: execution.contactId }, async () => {
    const fresh = await adapter.findOne(COLLECTIONS.cadenceExecutions, { id: execution.id });
    if (!fresh || !['scheduled', 'waiting'].includes(fresh.status)) return { idle: true };
    const cadence = await adapter.findOne(COLLECTIONS.cadences, { tenantId: fresh.tenantId, id: fresh.cadenceId });
    if (!cadence || cadence.status !== 'active') {
      await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: fresh.id }, { $set: { status: 'paused', stopReason: 'cadence_inactive', updatedAt: nowIso() } });
      return { paused: true };
    }
    const step = cadence.steps?.[fresh.currentStep];
    if (!step) {
      await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: fresh.id }, { $set: { status: 'completed', nextExecutionAt: null, updatedAt: nowIso() } });
      await syncCadenceCampaign({ tenantId: fresh.tenantId, campaignId: fresh.campaignId });
      return { completed: true };
    }
    const campaignItem = fresh.campaignItemId
      ? await adapter.findOne(COLLECTIONS.campaignItems, { tenantId: fresh.tenantId, id: fresh.campaignItemId })
      : null;
    const shouldSkip = (step.skipIfReplied === true && Boolean(campaignItem?.repliedAt))
      || (step.skipIfRead === true && Boolean(campaignItem?.readAt))
      || !matchesStepConditions(step.conditions, campaignItem);
    if (shouldSkip) {
      const nextStepIndex = nextStepIndexFor({ execution: fresh, cadence, campaignItem });
      const nextStep = cadence.steps?.[nextStepIndex] || null;
      await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: fresh.id }, {
        $set: {
          currentStep: nextStepIndex,
          status: nextStep ? 'scheduled' : 'completed',
          nextExecutionAt: nextStep ? addMinutes(nowIso(), nextStep.delayMinutes) : null,
          lastExecutionAt: nowIso(), lockedAt: null, stopReason: 'step_skipped', updatedAt: nowIso()
        }
      });
      await syncCadenceCampaign({ tenantId: fresh.tenantId, campaignId: fresh.campaignId });
      return { skipped: true, reason: 'step_conditions', executionId: fresh.id };
    }
    if (step.action !== 'close_cadence' && fresh.campaignId) {
      const campaign = await adapter.findOne(COLLECTIONS.campaigns, { tenantId: fresh.tenantId, id: fresh.campaignId });
      if (campaign?.status === 'paused') {
        await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: fresh.id }, { $set: { status: 'paused', stopReason: 'campaign_paused', updatedAt: nowIso() } });
        return { paused: true, reason: 'campaign_paused' };
      }
      const pausadaPorCobranca = campaign
        ? await pauseCampaignIfBillingBlocked(campaign).catch((error) => {
          console.warn('[CADENCE] Falha ao conferir cobranca:', error.message);
          return null;
        })
        : null;
      if (pausadaPorCobranca) {
        await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: fresh.id }, { $set: { status: 'paused', stopReason: 'billing_blocked', lockedAt: null, updatedAt: nowIso() } });
        return { paused: true, reason: 'billing_blocked' };
      }
      const pausada = campaign
        ? await checkCampaignQuality(campaign, { extraTemplateIds: [step.templateId] }).catch((error) => {
          console.warn('[CADENCE] Falha ao conferir qualidade:', error.message);
          return null;
        })
        : null;
      if (pausada) return { paused: true, reason: 'quality_guard' };
    }
    const gate = await canSendExecution({ execution: fresh, cadence, campaignItem });
    if (!gate.allowed) {
      if (gate.reason === 'outside_window') {
        await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: fresh.id }, { $set: { status: 'waiting', nextExecutionAt: gate.retryAt, stopReason: gate.reason, updatedAt: nowIso() } });
        return { deferred: true, reason: gate.reason };
      }
      const terminalStatus = gate.reason === 'opted_out' ? 'opted_out' : 'waiting';
      await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: fresh.id }, { $set: { status: terminalStatus, stopReason: gate.reason, nextExecutionAt: terminalStatus === 'waiting' ? addMinutes(nowIso(), 60) : null, updatedAt: nowIso() } });
      return { skipped: true, reason: gate.reason };
    }
    const stepSender = step.senderPhoneNumberId || campaignItem?.senderPhoneNumberId || 'default';
    const quota = await consumeOutreachQuota({ tenantId: fresh.tenantId, senderPhoneNumberId: stepSender });
    if (!quota.allowed) {
      await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: fresh.id }, { $set: { status: 'waiting', nextExecutionAt: quota.retryAt, stopReason: quota.reason, updatedAt: nowIso() } });
      return { deferred: true, reason: quota.reason };
    }
    await waitOutreachJitter();
    const now = nowIso();
    await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: fresh.id }, { $set: { status: 'running', lockedAt: now, updatedAt: now }, $inc: { attemptCount: 1 } });
    try {
      if (step.action === 'close_cadence') {
        await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: fresh.id }, { $set: { status: 'completed', nextExecutionAt: null, lastExecutionAt: nowIso(), lockedAt: null, updatedAt: nowIso() } });
        await syncCadenceCampaign({ tenantId: fresh.tenantId, campaignId: fresh.campaignId });
        return { completed: true };
      }
      const result = await performWhatsAppContactOutreach({
        tenantId: fresh.tenantId,
        contactId: fresh.contactId,
        phoneEntryId: campaignItem?.phoneEntryId || null,
        templateId: step.templateId,
        senderPhoneNumberId: step.senderPhoneNumberId || null,
        values: step.values || {},
        actor: { id: 'cadence-worker', name: 'Cadence Worker', role: 'SYSTEM' }
      });
      const sentAt = nowIso();
      if (campaignItem?.id) {
        await adapter.updateOne(COLLECTIONS.campaignItems, { tenantId: fresh.tenantId, id: campaignItem.id }, {
          $set: {
            status: 'sent', deliveryStatus: 'sent', sentAt,
            outreachId: result?.outreach?.id || campaignItem.outreachId || null,
            chatId: result?.chat?.id || campaignItem.chatId || null,
            providerMessageId: result?.providerMessageId || campaignItem.providerMessageId || null,
            updatedAt: sentAt
          }
        });
        if (result?.outreach?.id) {
          await adapter.updateOne(COLLECTIONS.outreachHistory, { id: result.outreach.id }, {
            $set: {
              campaignId: fresh.campaignId,
              campaignItemId: campaignItem.id,
              turizmoLeadId: fresh.turizmoLeadId || null,
              updatedAt: sentAt
            }
          });
        }
      }
      const nextStepIndex = nextStepIndexFor({ execution: fresh, cadence, campaignItem });
      const nextStep = cadence.steps?.[nextStepIndex] || null;
      await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: fresh.id }, {
        $set: {
          currentStep: nextStepIndex,
          status: nextStep ? 'scheduled' : 'completed',
          nextExecutionAt: nextStep ? addMinutes(nowIso(), nextStep.delayMinutes) : null,
          lastExecutionAt: nowIso(), lockedAt: null, stopReason: null, updatedAt: nowIso()
        }
      });
      await syncCadenceCampaign({ tenantId: fresh.tenantId, campaignId: fresh.campaignId });
      return { ok: true, executionId: fresh.id, step: step.order };
    } catch (error) {
      await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: fresh.id }, {
        $set: { status: 'waiting', nextExecutionAt: addMinutes(nowIso(), Math.min(60, 2 ** Math.min(6, Number(fresh.attemptCount || 0)))), lockedAt: null, stopReason: String(error.message || 'send_failed').slice(0, 300), updatedAt: nowIso() }
      });
      throw error;
    }
  });
};

export const recoverStaleCadenceExecutions = async () => {
  const cutoff = new Date(Date.now() - envInt('CADENCE_LOCK_TIMEOUT_MS', 5 * 60 * 1000, { min: 30000, max: 3600000 })).toISOString();
  const stale = await adapter.findMany(COLLECTIONS.cadenceExecutions, { query: { status: 'running', lockedAt: { $lt: cutoff } }, limit: 1000 });
  for (const execution of stale) {
    await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: execution.id }, { $set: { status: 'waiting', lockedAt: null, nextExecutionAt: nowIso(), stopReason: 'recovered_after_restart', updatedAt: nowIso() } });
  }
  return stale.length;
};
