import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dbPath = path.join(os.tmpdir(), `onion-protected-classification-${process.pid}.json`);

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'protected-classification-test-secret';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.TURIZMO_INTEGRATION_ENABLED = 'false';
process.env.AI_CLASSIFICATION_ENABLED = 'true';
process.env.AI_PROVIDER = 'gemini';
process.env.AI_REASONING_ENABLED = 'false';
process.env.GEMINI_API_KEY = 'protected-classification-test-key';
process.env.GEMINI_MODEL = 'protected-classification-test-model';
process.env.GEMINI_FALLBACK_MODELS = '';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { notifyProtectedAttendanceInbound } = await import('../src/services/protectedAttendance.js');
const { classifyMessage } = await import('../src/services/aiClassification.js');

const originalFetch = global.fetch;
const tenantId = 'tenant_protected';
const chatId = 'chat_protected';
const campaignId = 'campaign_protected';
const campaignItemId = 'campaign_item_protected';
const turizmoCampaignId = 'turizmo_campaign_protected';
const turizmoLeadId = 'turizmo_lead_protected';
const targetMessageId = 'msg_protected_inbound';

const waitFor = async (predicate, timeoutMs = 2000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timeout_waiting_for_protected_classification');
};

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const input = JSON.parse(body.contents[0].parts[0].text);
    assert.equal(input.currentMessage, 'Qual e o valor?');
    return new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              intent: 'pediu_preco',
              sentiment: 'positive',
              confidence: 0.96,
              reason: 'O lead solicitou o valor.',
              nextAction: 'notify_sales',
              suggestedReply: null,
              followUpAt: null,
              requiresHumanReview: false,
              optOutDetected: false
            })
          }]
        }
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const createdAt = new Date(Date.now() - 60_000).toISOString();
  await adapter.insertOne('outreachCampaigns', {
    id: campaignId,
    tenantId,
    turizmoCampaignId,
    automationManagedBy: 'turizmo',
    journeyVersion: 1,
    status: 'processing',
    createdAt,
    updatedAt: createdAt
  });
  await adapter.insertOne('outreachCampaignItems', {
    id: campaignItemId,
    tenantId,
    campaignId,
    contactId: 'contact_protected',
    turizmoLeadId,
    chatId,
    status: 'replied',
    createdAt,
    updatedAt: createdAt
  });
  await adapter.insertOne('activeChats', {
    id: chatId,
    tenantId,
    contactId: 'contact_protected',
    turizmoLeadId,
    turizmoCampaignId,
    campaignId,
    source: 'turizmo_handoff',
    status: 'waiting',
    mode: 'human',
    automationMode: 'human',
    automationLocked: true,
    protectedAttendance: true,
    flowStarted: false,
    postHandoff: { holdHours: 72, inboundDuringHold: 'notify_turizmo' },
    createdAt,
    updatedAt: createdAt
  });
  await adapter.insertOne('turizmoAutomationStates', {
    id: 'state_protected',
    tenantId,
    turizmoLeadId,
    turizmoCampaignId,
    campaignId,
    chatId,
    automationLocked: true,
    protectedAttendance: true,
    stage: 'human_handoff',
    createdAt,
    updatedAt: createdAt
  });

  for (let index = 0; index < 9; index += 1) {
    const timestamp = new Date(Date.now() - 30_000 + index).toISOString();
    await adapter.insertOne('chatMessages', {
      id: `${chatId}_context_${index}`,
      tenantId,
      chatId,
      messageId: `context_${index}`,
      sender: index % 2 === 0 ? 'agent' : 'user',
      text: `Contexto protegido ${index}`,
      timestamp,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  const timestamp = new Date().toISOString();
  await adapter.insertOne('chatMessages', {
    id: `${chatId}_${targetMessageId}`,
    tenantId,
    chatId,
    messageId: targetMessageId,
    sender: 'user',
    text: 'Qual e o valor?',
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  });
});

after(async () => {
  global.fetch = originalFetch;
  await adapter.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

test('inbound protegido notifica, classifica uma vez e mantem automacao bloqueada', async () => {
  const chat = await adapter.findOne('activeChats', { tenantId, id: chatId });
  const message = {
    id: targetMessageId,
    messageId: targetMessageId,
    sender: 'user',
    text: 'Qual e o valor?',
    timestamp: new Date().toISOString()
  };

  const first = await notifyProtectedAttendanceInbound({ chat, message });
  const replay = await notifyProtectedAttendanceInbound({ chat, message });
  assert.equal(first.handled, true);
  assert.equal(first.classificationQueued, true);
  assert.equal(replay.handled, true);

  await waitFor(async () => (
    await adapter.countDocuments('messageClassifications', { tenantId, messageId: targetMessageId })
  ) === 1);

  const classification = await adapter.findOne('messageClassifications', {
    tenantId,
    messageId: targetMessageId
  });
  assert.equal(classification.intent, 'pediu_preco');
  assert.equal(classification.classificationRevision, 1);
  assert.equal(classification.campaignId, campaignId);
  assert.equal(classification.campaignItemId, campaignItemId);
  assert.equal(classification.turizmoCampaignId, turizmoCampaignId);
  assert.equal(classification.turizmoLeadId, turizmoLeadId);
  assert.equal(classification.chatId, chatId);
  assert.equal(classification.automationManagedBy, 'turizmo');
  assert.equal(classification.recentMessages.length, 10);

  const classifiedEvents = await adapter.findMany('integrationOutbox', {
    query: {
      tenantId,
      eventType: 'lead.classified',
      'payload.data.messageId': targetMessageId
    }
  });
  const waitingEvents = await adapter.findMany('integrationOutbox', {
    query: {
      tenantId,
      eventType: 'attendance.message_waiting',
      'payload.data.messageId': targetMessageId
    }
  });
  assert.equal(classifiedEvents.length, 1);
  assert.equal(waitingEvents.length, 1);
  assert.equal(classifiedEvents[0].payload.data.recentMessages.length, 10);

  const duplicate = await classifyMessage({ tenantId, messageId: targetMessageId });
  assert.equal(duplicate.duplicate, true);
  assert.equal(await adapter.countDocuments('messageClassifications', { tenantId, messageId: targetMessageId }), 1);
  assert.equal(await adapter.countDocuments('integrationOutbox', {
    tenantId,
    eventType: 'lead.classified',
    'payload.data.messageId': targetMessageId
  }), 1);

  const protectedChat = await adapter.findOne('activeChats', { tenantId, id: chatId });
  assert.equal(protectedChat.automationLocked, true);
  assert.equal(protectedChat.protectedAttendance, true);
  assert.equal(protectedChat.attendanceStatus, 'message_waiting');
  assert.equal(protectedChat.flowStarted, false);
  assert.equal(await adapter.countDocuments('chatMessages', { tenantId, chatId }), 10);
  assert.equal(await adapter.countDocuments('commercialTasks', { tenantId }), 0);
  assert.equal(await adapter.countDocuments('attendanceRoutingDecisions', { tenantId }), 0);
  assert.equal(await adapter.countDocuments('turizmoAutomationCommands', { tenantId }), 0);
});
