import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dbPath = path.join(os.tmpdir(), `onion-classification-revision-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'classification-revision-test-secret';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.TURIZMO_INTEGRATION_ENABLED = 'false';
process.env.AI_CLASSIFICATION_ENABLED = 'true';
process.env.AI_PROVIDER = 'gemini';
process.env.AI_REASONING_ENABLED = 'false';
process.env.GEMINI_API_KEY = 'gemini-classification-test-key';
process.env.GEMINI_MODEL = 'gemini-classification-test';
process.env.GEMINI_FALLBACK_MODELS = '';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { classifyMessage } = await import('../src/services/aiClassification.js');
const { attributeInboundReply } = await import('../src/services/replyAttribution.js');

const originalFetch = global.fetch;

const providerResult = (input) => {
  const text = String(input?.currentMessage || '').toLowerCase();
  if (text.includes('tenho interesse') || text.includes('quero saber')) {
    return {
      intent: 'positivo', sentiment: 'positive', confidence: 0.95,
      reason: 'Lead corrigiu o contexto e demonstrou interesse.', nextAction: 'notify_sales',
      suggestedReply: null, followUpAt: null, requiresHumanReview: false, optOutDetected: false
    };
  }
  return {
    intent: 'fora_de_contexto', sentiment: 'unknown', confidence: 0.92,
    reason: 'Mensagem inicial nao possui relacao com a campanha.', nextAction: 'do_nothing',
    suggestedReply: null, followUpAt: null, requiresHumanReview: false, optOutDetected: false
  };
};

const installProvider = ({ delayMs = 0, onActive = null } = {}) => {
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const input = JSON.parse(body.contents[0].parts[0].text);
    onActive?.(1);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    onActive?.(-1);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(providerResult(input)) }] } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
};

const insertMessage = async ({ messageId, text, timestamp }) => {
  await adapter.insertOne('chatMessages', {
    id: `chat_incremental_${messageId}`,
    tenantId: 'tenant_incremental',
    chatId: 'chat_incremental',
    messageId,
    sender: 'user',
    text,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  return { id: messageId, messageId, sender: 'user', text, timestamp };
};

const waitForFallback = () => new Promise((resolve) => setTimeout(resolve, 25));

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  installProvider();
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  await adapter.insertOne('activeChats', {
    id: 'chat_incremental', tenantId: 'tenant_incremental', contactId: 'contact_incremental',
    status: 'bot', channel: 'whatsapp', createdAt, updatedAt: createdAt
  });
  await adapter.insertOne('outreachCampaigns', {
    id: 'campaign_incremental', tenantId: 'tenant_incremental', turizmoCampaignId: 'tur_campaign_incremental',
    automationManagedBy: 'turizmo', journeyVersion: 1, status: 'processing', createdAt, updatedAt: createdAt
  });
  await adapter.insertOne('outreachCampaignItems', {
    id: 'item_incremental', tenantId: 'tenant_incremental', campaignId: 'campaign_incremental',
    contactId: 'contact_incremental', turizmoLeadId: 'lead_incremental', outreachId: 'outreach_incremental',
    phoneNumber: '5511999990001', status: 'sent', sentAt: createdAt, createdAt, updatedAt: createdAt
  });
  await adapter.insertOne('contactOutreachHistory', {
    id: 'outreach_incremental', tenantId: 'tenant_incremental', campaignId: 'campaign_incremental',
    campaignItemId: 'item_incremental', contactId: 'contact_incremental', chatId: 'chat_incremental',
    providerMessageId: 'provider_initial_campaign_message', status: 'sent', createdAt, updatedAt: createdAt
  });
});

after(async () => {
  global.fetch = originalFetch;
  await adapter.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

test('cada inbound Turizmo gera classificacao e evento incremental proprios', async () => {
  for (let index = 0; index < 8; index += 1) {
    const timestamp = new Date(Date.now() - 30_000 + index).toISOString();
    await adapter.insertOne('chatMessages', {
      id: `chat_incremental_context_${index}`,
      tenantId: 'tenant_incremental',
      chatId: 'chat_incremental',
      messageId: `context_${index}`,
      sender: index % 2 === 0 ? 'bot' : 'user',
      text: `Contexto anterior ${index}`,
      timestamp,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }
  const firstAt = new Date(Date.now() - 10_000).toISOString();
  const firstMessage = await insertMessage({
    messageId: 'msg_context_1',
    text: 'Voce ligou para a pessoa errada.',
    timestamp: firstAt
  });
  process.env.AI_CLASSIFICATION_ENABLED = 'false';
  const firstAttribution = await attributeInboundReply({
    tenantId: 'tenant_incremental',
    chat: { id: 'chat_incremental', tenantId: 'tenant_incremental', contactId: 'contact_incremental', status: 'bot' },
    message: firstMessage,
    replyToProviderMessageId: 'provider_initial_campaign_message'
  });
  assert.equal(firstAttribution.attributed, true);
  await waitForFallback();
  process.env.AI_CLASSIFICATION_ENABLED = 'true';

  const first = await classifyMessage({ tenantId: 'tenant_incremental', messageId: firstMessage.id });
  assert.equal(first.intent, 'fora_de_contexto');
  assert.equal(first.classificationRevision, 1);

  const secondAt = new Date(Date.now() - 5_000).toISOString();
  const secondMessage = await insertMessage({
    messageId: 'msg_context_2',
    text: 'Desculpe, agora entendi. Tenho interesse e quero saber mais.',
    timestamp: secondAt
  });
  process.env.AI_CLASSIFICATION_ENABLED = 'false';
  const secondAttribution = await attributeInboundReply({
    tenantId: 'tenant_incremental',
    chat: { id: 'chat_incremental', tenantId: 'tenant_incremental', contactId: 'contact_incremental', status: 'bot' },
    message: secondMessage
  });
  assert.equal(secondAttribution.attributed, true);
  await waitForFallback();
  process.env.AI_CLASSIFICATION_ENABLED = 'true';

  const second = await classifyMessage({ tenantId: 'tenant_incremental', messageId: secondMessage.id });
  assert.equal(second.intent, 'positivo');
  assert.notEqual(second.id, first.id);
  assert.equal(second.messageId, secondMessage.id);
  assert.equal(second.classificationRevision, 1);
  assert.notEqual(second.conversationContextHash, first.conversationContextHash);
  assert.equal(second.currentMessage, secondMessage.text);
  assert.ok(second.recentMessages.some((item) => item.messageId === firstMessage.id));
  assert.ok(second.recentMessages.some((item) => item.messageId === secondMessage.id));
  assert.equal(second.recentMessages.length, 10);

  const events = await adapter.findMany('integrationOutbox', {
    query: { tenantId: 'tenant_incremental', eventType: 'lead.classified' },
    sort: { createdAt: 1 }
  });
  assert.equal(events.length, 2);
  assert.notEqual(events[0].idempotencyKey, events[1].idempotencyKey);
  assert.equal(events[1].payload.data.classificationRevision, 1);
  assert.equal(events[1].payload.data.currentMessage, secondMessage.text);
  assert.equal(events[1].payload.data.recentMessages.length >= 2, true);

  assert.equal(await adapter.countDocuments('contactOutreachHistory', { tenantId: 'tenant_incremental' }), 1);
  assert.equal(await adapter.countDocuments('turizmoAutomationCommands', { tenantId: 'tenant_incremental' }), 0);
  assert.equal(await adapter.countDocuments('commercialTasks', { tenantId: 'tenant_incremental' }), 0);
  assert.equal(await adapter.countDocuments('attendanceRoutingDecisions', { tenantId: 'tenant_incremental' }), 0);
});

test('force reprocess incrementa revisao e retry da mesma revisao e idempotente', async () => {
  const latest = await adapter.findOne('messageClassifications', {
    tenantId: 'tenant_incremental',
    messageId: 'msg_context_2'
  });
  await adapter.updateOne('messageClassifications', {
    tenantId: 'tenant_incremental',
    id: latest.id
  }, { $set: { classificationRevision: null } });
  const revisionTwo = await classifyMessage({
    tenantId: 'tenant_incremental',
    messageId: latest.messageId,
    classificationId: latest.id,
    force: true,
    reprocessRequestId: 'reprocess_incremental_1'
  });
  assert.equal(revisionTwo.id, latest.id);
  assert.equal(revisionTwo.classificationRevision, 2);
  assert.equal(revisionTwo.duplicate, false);
  assert.ok(revisionTwo.reprocessedAt);

  const retry = await classifyMessage({
    tenantId: 'tenant_incremental',
    messageId: latest.messageId,
    classificationId: latest.id,
    force: true,
    reprocessRequestId: 'reprocess_incremental_1'
  });
  assert.equal(retry.classificationRevision, 2);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.outboxDuplicate, true);

  const revisionThree = await classifyMessage({
    tenantId: 'tenant_incremental',
    messageId: latest.messageId,
    classificationId: latest.id,
    force: true,
    reprocessRequestId: 'reprocess_incremental_2'
  });
  assert.equal(revisionThree.classificationRevision, 3);
  assert.notEqual(revisionThree.classificationIdempotencyKey, revisionTwo.classificationIdempotencyKey);

  const revisionEvents = await adapter.findMany('integrationOutbox', {
    query: {
      tenantId: 'tenant_incremental',
      eventType: 'lead.classified',
      'payload.data.classificationId': latest.id
    }
  });
  assert.equal(revisionEvents.length, 3);
  assert.deepEqual(
    revisionEvents.map((item) => item.payload.data.classificationRevision).sort(),
    [1, 2, 3]
  );
  assert.equal(await adapter.countDocuments('contactOutreachHistory', { tenantId: 'tenant_incremental' }), 1);
  assert.equal(await adapter.countDocuments('turizmoAutomationCommands', { tenantId: 'tenant_incremental' }), 0);
});

test('classificacoes do mesmo chat sao serializadas e mantem ids separados', async () => {
  let active = 0;
  let maxActive = 0;
  installProvider({
    delayMs: 30,
    onActive: (delta) => {
      active += delta;
      maxActive = Math.max(maxActive, active);
    }
  });
  const base = Date.now();
  for (const [index, text] of ['Mensagem paralela sem contexto', 'Tenho interesse na oferta'].entries()) {
    const messageId = `msg_parallel_${index + 1}`;
    const timestamp = new Date(base + index).toISOString();
    await adapter.insertOne('chatMessages', {
      id: `chat_incremental_${messageId}`, tenantId: 'tenant_incremental', chatId: 'chat_incremental',
      messageId, sender: 'user', text, timestamp, createdAt: timestamp, updatedAt: timestamp,
      outreachId: 'outreach_incremental', campaignId: 'campaign_incremental',
      campaignItemId: 'item_incremental', contactId: 'contact_incremental', turizmoLeadId: 'lead_incremental'
    });
  }
  const [first, second] = await Promise.all([
    classifyMessage({ tenantId: 'tenant_incremental', messageId: 'msg_parallel_1' }),
    classifyMessage({ tenantId: 'tenant_incremental', messageId: 'msg_parallel_2' })
  ]);
  assert.equal(maxActive, 1);
  assert.notEqual(first.id, second.id);
  assert.equal(first.classificationRevision, 1);
  assert.equal(second.classificationRevision, 1);
  installProvider();
});
