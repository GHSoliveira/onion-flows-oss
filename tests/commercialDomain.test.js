import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dbPath = path.join(os.tmpdir(), `onion-commercial-test-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'commercial-domain-test-secret-not-for-production';
process.env.AI_CLASSIFICATION_ENABLED = 'false';
process.env.AI_PROVIDER = 'rules';
process.env.TURIZMO_INTEGRATION_ENABLED = 'false';
process.env.CADENCE_ENGINE_ENABLED = 'true';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { attributeInboundReply } = await import('../src/services/replyAttribution.js');
const { classifyMessage } = await import('../src/services/aiClassification.js');
const { isWithinCadenceWindow, processNextCadenceExecution, stopCadencesForContact } = await import('../src/services/cadenceEngine.js');
const { isContactSuppressed, suppressContact } = await import('../src/services/contactSuppression.js');
const { calculateCampaignMetrics, recordCampaignMetricOnce } = await import('../src/services/outreachMetrics.js');
const { createTurizmoEvent, enqueueTurizmoEvent, processNextTurizmoEvent } = await import('../src/services/integrationOutbox.js');
const { consumeOutreachQuota } = await import('../src/services/outreachRateLimit.js');
const { normalizeIdentifier } = await import('../src/services/outreachDomain.js');
const { releaseDueScheduledCampaigns } = await import('../src/services/outreachCampaignWorker.js');

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
});

after(async () => {
  await adapter.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

test('suppression is tenant scoped and idempotent', async () => {
  const first = await suppressContact({ tenantId: 'tenant_a', contactId: 'contact_1', identifier: '+55 11 99999-0000', reason: 'opt_out' });
  const duplicate = await suppressContact({ tenantId: 'tenant_a', contactId: 'contact_1', identifier: '5511999990000', reason: 'manual' });
  assert.equal(first.id, duplicate.id);
  assert.equal(await isContactSuppressed({ tenantId: 'tenant_a', channel: 'whatsapp', identifier: '5511999990000' }), true);
  assert.equal(await isContactSuppressed({ tenantId: 'tenant_b', channel: 'whatsapp', identifier: '5511999990000' }), false);
});

test('campaign metrics do not double count the same event', async () => {
  await adapter.insertOne('outreachCampaigns', { id: 'campaign_metrics', tenantId: 'tenant_a', totalContacts: 1, sentCount: 0, createdAt: new Date().toISOString() });
  await adapter.insertOne('outreachCampaignItems', { id: 'item_metrics', tenantId: 'tenant_a', campaignId: 'campaign_metrics', status: 'sent', sentAt: new Date().toISOString() });
  const payload = { tenantId: 'tenant_a', campaignId: 'campaign_metrics', campaignItemId: 'item_metrics', type: 'sent', sourceId: 'provider_1' };
  assert.equal(await recordCampaignMetricOnce(payload), true);
  assert.equal(await recordCampaignMetricOnce(payload), false);
  const campaign = await adapter.findOne('outreachCampaigns', { id: 'campaign_metrics' });
  assert.equal(campaign.sentCount, 1);
});

test('campaign metrics v2 ignore null delivery timestamps and support legacy rollback', async () => {
  await adapter.insertOne('outreachCampaigns', {
    id: 'campaign_metric_flags', tenantId: 'tenant_a', totalContacts: 2,
    sentCount: 1, deliveredCount: 0, readCount: 0, repliedCount: 0,
    createdAt: new Date().toISOString()
  });
  await adapter.insertOne('outreachCampaignItems', {
    id: 'item_metric_flags', tenantId: 'tenant_a', campaignId: 'campaign_metric_flags',
    status: 'sent', sentAt: new Date().toISOString(), deliveredAt: null, readAt: null
  });
  process.env.OUTREACH_METRICS_V2_ENABLED = 'true';
  const v2 = await calculateCampaignMetrics({ tenantId: 'tenant_a', campaignId: 'campaign_metric_flags' });
  assert.equal(v2.sentCount, 1);
  assert.equal(v2.deliveredCount, 0);
  process.env.OUTREACH_METRICS_V2_ENABLED = 'false';
  const legacy = await calculateCampaignMetrics({ tenantId: 'tenant_a', campaignId: 'campaign_metric_flags' });
  assert.equal(legacy.source, 'legacy_aggregate');
  assert.equal(legacy.totalContacts, 2);
  process.env.OUTREACH_METRICS_V2_ENABLED = 'true';
});

test('inbound reply is attributed once and stops cadence', async () => {
  const now = new Date();
  const sentAt = new Date(now.getTime() - 5000).toISOString();
  await adapter.insertOne('outreachCampaigns', { id: 'campaign_reply', tenantId: 'tenant_a', totalContacts: 1, sentCount: 1, repliedCount: 0, createdAt: sentAt });
  await adapter.insertOne('outreachCampaignItems', { id: 'item_reply', tenantId: 'tenant_a', campaignId: 'campaign_reply', contactId: 'contact_reply', phoneNumber: '5511888880000', outreachId: 'outreach_reply', status: 'sent', sentAt, createdAt: sentAt });
  await adapter.insertOne('contactOutreachHistory', { id: 'outreach_reply', tenantId: 'tenant_a', campaignId: 'campaign_reply', campaignItemId: 'item_reply', contactId: 'contact_reply', chatId: 'chat_reply', providerMessageId: 'provider_outbound', createdAt: sentAt });
  await adapter.insertOne('cadenceExecutions', { id: 'exec_reply', tenantId: 'tenant_a', contactId: 'contact_reply', status: 'waiting', nextExecutionAt: now.toISOString() });
  await adapter.insertOne('chatMessages', { id: 'chat_reply_msg_reply', tenantId: 'tenant_a', chatId: 'chat_reply', messageId: 'msg_reply', sender: 'user', text: 'Quero uma demonstracao', timestamp: now.toISOString(), createdAt: now.toISOString() });
  const chat = { id: 'chat_reply', tenantId: 'tenant_a', contactId: 'contact_reply' };
  const message = { id: 'msg_reply', text: 'Quero uma demonstracao', timestamp: now.toISOString() };
  const result = await attributeInboundReply({ tenantId: 'tenant_a', chat, message, replyToProviderMessageId: 'provider_outbound' });
  assert.equal(result.attributed, true);
  const item = await adapter.findOne('outreachCampaignItems', { id: 'item_reply' });
  assert.equal(item.status, 'replied');
  assert.equal(item.replyMessageId, 'msg_reply');
  const execution = await adapter.findOne('cadenceExecutions', { id: 'exec_reply' });
  assert.equal(execution.status, 'stopped_by_reply');
  const duplicate = await attributeInboundReply({ tenantId: 'tenant_a', chat, message, replyToProviderMessageId: 'provider_outbound' });
  assert.equal(duplicate.duplicate, true);
  const campaign = await adapter.findOne('outreachCampaigns', { id: 'campaign_reply' });
  assert.equal(campaign.repliedCount, 1);
});

test('rule based classifier persists structured result and campaign relation', async () => {
  process.env.AI_CLASSIFICATION_ENABLED = 'true';
  const result = await classifyMessage({ tenantId: 'tenant_a', messageId: 'msg_reply' });
  assert.equal(result.intent, 'pediu_demo');
  assert.equal(result.requiresHumanReview, false);
  const item = await adapter.findOne('outreachCampaignItems', { id: 'item_reply' });
  assert.equal(item.status, 'qualified');
  assert.equal(item.classificationId, result.id);
  process.env.AI_CLASSIFICATION_ENABLED = 'false';
});

test('cadence window honors configured weekday and time', () => {
  const always = { timezone: 'UTC', allowedWeekdays: [0, 1, 2, 3, 4, 5, 6], allowedStartTime: '00:00', allowedEndTime: '23:59' };
  assert.equal(isWithinCadenceWindow(always, new Date('2026-08-10T12:00:00.000Z')), true);
  const closed = { ...always, allowedWeekdays: [0] };
  assert.equal(isWithinCadenceWindow(closed, new Date('2026-08-10T12:00:00.000Z')), false);
});

test('cadence campaign only completes after its execution terminates', async () => {
  process.env.OUTREACH_SEND_JITTER_MIN_MS = '0';
  process.env.OUTREACH_SEND_JITTER_MAX_MS = '0';
  const now = new Date().toISOString();
  await adapter.insertOne('outreachCampaigns', { id: 'campaign_cadence', tenantId: 'tenant_a', cadenceId: 'cadence_close', status: 'scheduled', totalContacts: 1, pendingCount: 1, sentCount: 0, failedCount: 0, createdAt: now, startedAt: null, finishedAt: null });
  await adapter.insertOne('outreachCampaignItems', { id: 'item_cadence', tenantId: 'tenant_a', campaignId: 'campaign_cadence', contactId: 'contact_cadence', phoneNumber: '5511666660000', status: 'scheduled', createdAt: now });
  await adapter.insertOne('cadences', { id: 'cadence_close', tenantId: 'tenant_a', status: 'active', timezone: 'UTC', allowedWeekdays: [0, 1, 2, 3, 4, 5, 6], allowedStartTime: '00:00', allowedEndTime: '23:59', steps: [{ order: 1, delayMinutes: 0, action: 'close_cadence' }], createdAt: now });
  await adapter.insertOne('cadenceExecutions', { id: 'exec_cadence', tenantId: 'tenant_a', cadenceId: 'cadence_close', campaignId: 'campaign_cadence', campaignItemId: 'item_cadence', contactId: 'contact_cadence', currentStep: 0, status: 'scheduled', nextExecutionAt: now, attemptCount: 0, createdAt: now });
  await processNextCadenceExecution({ executionId: 'exec_cadence' });
  const campaign = await adapter.findOne('outreachCampaigns', { id: 'campaign_cadence' });
  assert.equal(campaign.status, 'completed');
  assert.equal(campaign.pendingCount, 0);
  assert.ok(campaign.finishedAt);
});

test('scheduled campaign is released only when scheduledAt is due', async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 3600000).toISOString();
  await adapter.insertOne('outreachCampaigns', { id: 'campaign_due', tenantId: 'tenant_a', status: 'scheduled', cadenceId: null, scheduledAt: past, createdAt: past });
  await adapter.insertOne('outreachCampaigns', { id: 'campaign_future', tenantId: 'tenant_a', status: 'scheduled', cadenceId: null, scheduledAt: future, createdAt: past });
  await adapter.insertOne('outreachCampaignItems', { id: 'item_due', tenantId: 'tenant_a', campaignId: 'campaign_due', status: 'scheduled', createdAt: past });
  await adapter.insertOne('outreachCampaignItems', { id: 'item_future', tenantId: 'tenant_a', campaignId: 'campaign_future', status: 'scheduled', createdAt: past });
  const released = await releaseDueScheduledCampaigns();
  assert.equal(released.some((item) => item.id === 'campaign_due'), true);
  assert.equal(released.some((item) => item.id === 'campaign_future'), false);
  assert.equal((await adapter.findOne('outreachCampaignItems', { id: 'item_due' })).status, 'pending');
  assert.equal((await adapter.findOne('outreachCampaignItems', { id: 'item_future' })).status, 'scheduled');
});

test('cadence configured to continue on reply is not stopped prematurely', async () => {
  const now = new Date().toISOString();
  await adapter.insertOne('cadences', { id: 'cadence_continue', tenantId: 'tenant_a', status: 'active', stopOnReply: false, steps: [{ order: 1, delayMinutes: 60, action: 'close_cadence' }], createdAt: now });
  await adapter.insertOne('cadenceExecutions', { id: 'exec_continue', tenantId: 'tenant_a', cadenceId: 'cadence_continue', campaignId: null, contactId: 'contact_continue', status: 'waiting', nextExecutionAt: now, createdAt: now });
  await stopCadencesForContact({ tenantId: 'tenant_a', contactId: 'contact_continue', reason: 'stopped_by_reply' });
  const execution = await adapter.findOne('cadenceExecutions', { id: 'exec_continue' });
  assert.equal(execution.status, 'waiting');
});

test('campaign aggregate is reconstructed from item state', async () => {
  const metrics = await calculateCampaignMetrics({ tenantId: 'tenant_a', campaignId: 'campaign_reply' });
  assert.equal(metrics.repliedCount, 1);
  assert.equal(metrics.qualifiedCount, 1);
  assert.equal(metrics.demoRequestedCount, 1);
  await stopCadencesForContact({ tenantId: 'tenant_a', contactId: 'missing' });
});

test('identifiers and outbox idempotency remain isolated by tenant', async () => {
  assert.equal(normalizeIdentifier('+55 (11) 99999-0000'), '5511999990000');
  const eventA = createTurizmoEvent({ tenantId: 'tenant_a', type: 'lead.classified', aggregateType: 'lead', aggregateId: 'lead_1', idempotencyKey: 'same-key', data: { classificationId: 'classification_1' } });
  const eventB = createTurizmoEvent({ tenantId: 'tenant_b', type: 'lead.classified', aggregateType: 'lead', aggregateId: 'lead_1', idempotencyKey: 'same-key', data: { classificationId: 'classification_2' } });
  const first = await enqueueTurizmoEvent(eventA);
  const duplicate = await enqueueTurizmoEvent({ ...eventA, eventId: 'evt_duplicate' });
  const otherTenant = await enqueueTurizmoEvent(eventB);
  assert.equal(first.id, duplicate.id);
  assert.notEqual(first.id, otherTenant.id);
  assert.equal(first.payload.producer, 'onion-flows');
});

test('opt-out keyword suppresses before asynchronous classification', async () => {
  const now = new Date().toISOString();
  await adapter.insertOne('outreachCampaigns', { id: 'campaign_optout', tenantId: 'tenant_a', totalContacts: 1, repliedCount: 0, optOutCount: 0, createdAt: now });
  await adapter.insertOne('outreachCampaignItems', { id: 'item_optout', tenantId: 'tenant_a', campaignId: 'campaign_optout', contactId: 'contact_optout', phoneNumber: '5511777770000', outreachId: 'outreach_optout', status: 'sent', sentAt: now, createdAt: now });
  await adapter.insertOne('contactOutreachHistory', { id: 'outreach_optout', tenantId: 'tenant_a', campaignId: 'campaign_optout', campaignItemId: 'item_optout', contactId: 'contact_optout', chatId: 'chat_optout', createdAt: now });
  await adapter.insertOne('chatMessages', { id: 'chat_optout_msg_optout', tenantId: 'tenant_a', chatId: 'chat_optout', messageId: 'msg_optout', sender: 'user', text: 'Nao me envie mais mensagens', timestamp: now, createdAt: now });
  await attributeInboundReply({ tenantId: 'tenant_a', chat: { id: 'chat_optout', tenantId: 'tenant_a', contactId: 'contact_optout' }, message: { id: 'msg_optout', text: 'Nao me envie mais mensagens', timestamp: now } });
  assert.equal(await isContactSuppressed({ tenantId: 'tenant_a', channel: 'whatsapp', identifier: '5511777770000' }), true);
  const item = await adapter.findOne('outreachCampaignItems', { id: 'item_optout' });
  assert.equal(item.status, 'opted_out');
});

test('local outreach limiter blocks bursts per tenant and sender', async () => {
  process.env.OUTREACH_MAX_PER_MINUTE = '1';
  process.env.OUTREACH_MAX_PER_HOUR = '10';
  process.env.OUTREACH_MAX_PER_DAY = '10';
  const first = await consumeOutreachQuota({ tenantId: 'tenant_rate', senderPhoneNumberId: 'sender_1' });
  const second = await consumeOutreachQuota({ tenantId: 'tenant_rate', senderPhoneNumberId: 'sender_1' });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'minute_limit');
});

test('permanent Turizmo configuration failure goes to dead letter without losing event', async () => {
  process.env.TURIZMO_INTEGRATION_ENABLED = 'true';
  delete process.env.TURIZMO_API_KEY;
  const event = createTurizmoEvent({ tenantId: 'tenant_a', type: 'campaign.created', aggregateType: 'campaign', aggregateId: 'campaign_dead', idempotencyKey: 'campaign-dead', data: { campaignId: 'campaign_dead' } });
  const record = await enqueueTurizmoEvent(event);
  await assert.rejects(() => processNextTurizmoEvent({ outboxId: record.id }), /TURIZMO_API_KEY/);
  const persisted = await adapter.findOne('integrationOutbox', { id: record.id });
  assert.equal(persisted.status, 'dead_letter');
  process.env.TURIZMO_INTEGRATION_ENABLED = 'false';
});
