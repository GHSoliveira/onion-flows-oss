import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dbPath = path.join(os.tmpdir(), `onion-attendance-routing-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'attendance-routing-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.TURIZMO_INTEGRATION_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const {
  ensureDefaultAttendanceRoutingProfile,
  evaluateAttendanceRouting,
  routeClassifiedReplyToAttendance,
  syncAttendanceLifecycle
} = await import('../src/services/attendanceRouting.js');
const { ensureAgentWhatsAppChat } = await import('../src/services/activeOutreach.js');

const tenantId = 'tenant_routing_test';
const contact = { id: 'contact_1', tenantId, name: 'Lead Teste' };

const createDeferredChat = (suffix) => ensureAgentWhatsAppChat({
  tenantId,
  contact: { ...contact, id: `contact_${suffix}` },
  phoneNumber: `55119999${String(suffix).padStart(4, '0')}`,
  agent: { id: 'campaign_system', name: 'Campanha' },
  senderPhoneNumberId: 'sender_1',
  deferHumanAttendance: true
});

const classificationFor = (chat, suffix, patch = {}) => ({
  id: `classification_${suffix}`,
  tenantId,
  chatId: chat.id,
  messageId: `message_${suffix}`,
  contactId: chat.contactId,
  campaignId: 'campaign_1',
  campaignItemId: `campaign_item_${suffix}`,
  outreachId: `outreach_${suffix}`,
  turizmoLeadId: `lead_${suffix}`,
  intent: 'positivo',
  sentiment: 'positive',
  confidence: 0.95,
  nextAction: 'notify_sales',
  reason: 'Lead interessado',
  requiresHumanReview: false,
  optOutDetected: false,
  ...patch
});

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  await adapter.insertOne('tenants', { id: tenantId, name: 'Tenant Routing' });
  await adapter.insertOne('queues', { id: 'queue_commercial', tenantId, name: 'COMERCIAL', active: true });
  await adapter.insertOne('queues', { id: 'queue_review', tenantId, name: 'REVISAO_COMERCIAL', active: true });
});

after(async () => {
  await adapter.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

test('campaign send creates only a deferred prospect, not a human attendance', async () => {
  const chat = await createDeferredChat(1);
  assert.equal(chat.status, 'bot');
  assert.equal(chat.activeOutreach, true);
  assert.equal(chat.attendanceDeferred, true);
  assert.equal(chat.agentId, null);
  assert.equal(chat.queue, null);
});

test('manual active outreach keeps the existing human attendance behavior', async () => {
  const chat = await ensureAgentWhatsAppChat({
    tenantId,
    contact: { ...contact, id: 'contact_manual' },
    phoneNumber: '5511888888888',
    agent: { id: 'agent_1', name: 'Agente 1' },
    senderPhoneNumberId: 'sender_1'
  });
  assert.equal(chat.status, 'open');
  assert.equal(chat.agentId, 'agent_1');
  assert.equal(chat.queue, 'ATIVO');
  assert.notEqual(chat.attendanceDeferred, true);
});

test('declarative evaluator applies review before commercial fallback', async () => {
  const profile = await ensureDefaultAttendanceRoutingProfile({ tenantId });
  const result = evaluateAttendanceRouting({
    profile,
    context: { intent: 'revisao_humana', sentiment: 'unknown', confidence: 0.3, nextAction: 'request_human_review', requiresHumanReview: true }
  });
  assert.equal(result.matchedRuleId, 'human_review');
  assert.equal(result.action.queueRef, 'review');
});

test('positive campaign reply creates one waiting attendance and one linked task', async () => {
  const chat = await createDeferredChat(2);
  const classification = classificationFor(chat, 2);
  const first = await routeClassifiedReplyToAttendance({ classification });
  const duplicate = await routeClassifiedReplyToAttendance({ classification });
  const routed = await adapter.findOne('activeChats', { id: chat.id });
  const decisions = await adapter.countDocuments('attendanceRoutingDecisions', { tenantId, messageId: classification.messageId });
  const tasks = await adapter.countDocuments('commercialTasks', { tenantId, classificationId: classification.id });
  assert.equal(first.id, duplicate.id);
  assert.equal(decisions, 1);
  assert.equal(tasks, 1);
  assert.equal(routed.status, 'waiting');
  assert.equal(routed.queueId, 'queue_commercial');
  assert.equal(routed.priority, 'high');
  assert.equal(routed.source, 'campaign_reply');
  assert.equal(routed.automationLocked, true);
});

test('uncertain reply routes to the configured review queue', async () => {
  const chat = await createDeferredChat(3);
  const classification = classificationFor(chat, 3, {
    intent: 'revisao_humana', sentiment: 'unknown', confidence: 0.4,
    nextAction: 'request_human_review', requiresHumanReview: true
  });
  await routeClassifiedReplyToAttendance({ classification });
  const routed = await adapter.findOne('activeChats', { id: chat.id });
  assert.equal(routed.status, 'waiting');
  assert.equal(routed.queueId, 'queue_review');
});

test('claim and close synchronize the linked commercial task and outbox lifecycle', async () => {
  const chat = await createDeferredChat(6);
  const classification = classificationFor(chat, 6);
  await adapter.insertOne('messageClassifications', classification);
  await routeClassifiedReplyToAttendance({ classification });
  const assignedAt = new Date().toISOString();
  const assigned = {
    ...(await adapter.findOne('activeChats', { id: chat.id })),
    status: 'open', agentId: 'agent_sales', agentName: 'Agente Comercial', assignedAt, waitingSince: null
  };
  await adapter.updateOne('activeChats', { id: chat.id }, { $set: assigned });
  await syncAttendanceLifecycle({ type: 'assigned', chat: assigned, actor: { id: 'agent_sales' } });
  const assignedTask = await adapter.findOne('commercialTasks', { tenantId, classificationId: classification.id });
  assert.equal(assignedTask.assignedTo, 'agent_sales');
  assert.equal(assignedTask.status, 'open');

  const closed = { ...assigned, status: 'closed', closedAt: new Date(Date.now() + 1000).toISOString() };
  await adapter.updateOne('activeChats', { id: chat.id }, { $set: closed });
  await syncAttendanceLifecycle({ type: 'closed', chat: closed, actor: { id: 'agent_sales' }, result: 'resolved' });
  const closedTask = await adapter.findOne('commercialTasks', { tenantId, classificationId: classification.id });
  assert.equal(closedTask.status, 'completed');
  assert.equal(closedTask.result, 'resolved');
  assert.equal(await adapter.countDocuments('integrationOutbox', { tenantId, eventType: 'attendance.assigned' }), 1);
  assert.equal(await adapter.countDocuments('integrationOutbox', { tenantId, eventType: 'attendance.closed' }), 1);
});

test('opt-out and negative reply do not create human attendance', async () => {
  const optOutChat = await createDeferredChat(4);
  const optOut = classificationFor(optOutChat, 4, {
    intent: 'opt_out', sentiment: 'negative', nextAction: 'suppress_contact',
    optOutDetected: true, confidence: 0.99
  });
  const optOutDecision = await routeClassifiedReplyToAttendance({ classification: optOut });
  const persistedOptOut = await adapter.findOne('activeChats', { id: optOutChat.id });
  assert.equal(optOutDecision.status, 'suppressed');
  assert.equal(persistedOptOut.status, 'bot');
  assert.equal(persistedOptOut.activeOutreach, false);

  const negativeChat = await createDeferredChat(5);
  const negative = classificationFor(negativeChat, 5, {
    intent: 'negativo', sentiment: 'negative', nextAction: 'stop_cadence', confidence: 0.9
  });
  const negativeDecision = await routeClassifiedReplyToAttendance({ classification: negative });
  const persistedNegative = await adapter.findOne('activeChats', { id: negativeChat.id });
  assert.equal(negativeDecision.status, 'ignored');
  assert.equal(persistedNegative.status, 'bot');
  assert.equal(persistedNegative.activeOutreach, false);
});
