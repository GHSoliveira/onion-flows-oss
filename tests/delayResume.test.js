import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Delay em conversa real: o fluxo continua no segundo certo sem esperar o tick
// do watcher, e nunca continua duas vezes.

const dbPath = path.join(os.tmpdir(), `onion-delay-resume-${process.pid}.json`);

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'delay-resume-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_FAKE_SEND = 'true';
process.env.AI_CLASSIFICATION_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { handleWhatsAppWebhook } = await import('../src/services/whatsappHandler.js');
// Como no index.js: o import registra a rotina de retomada. O watcher em si
// (setInterval) nao e iniciado, entao so o timer pontual pode continuar o fluxo.
const { runChatRuntimeWatcherTick } = await import('../src/services/chatRuntimeWatcher.js');
const { getChatMessages } = await import('../src/services/chatMessages.js');

const TENANT = 'tenant_delay';
const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const webhook = (from, id) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba_test',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '5511900000000', phone_number_id: 'sender_delay' },
        contacts: [{ wa_id: from, profile: { name: 'Cliente' } }],
        messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'oi' } }]
      }
    }]
  }]
});

const chatDe = async (from) => {
  const chats = await adapter.findDocuments('activeChats', { tenantId: TENANT, channelUserId: from });
  assert.equal(chats.length, 1);
  return chats[0];
};

const textosDoBot = async (chatId) => (await getChatMessages(chatId))
  .filter((m) => m.sender === 'bot')
  .map((m) => m.text);

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();

  await adapter.insertOne('tenants', { id: TENANT, name: 'Tenant Delay', status: 'active' });
  await adapter.insertOne('channelConfigs', {
    id: `channels_${TENANT}`,
    tenantId: TENANT,
    whatsapp: { enabled: true, accessToken: 'test-access-token', phoneNumberId: 'sender_delay' }
  });
  await adapter.insertOne('flows', {
    id: 'flow_delay',
    tenantId: TENANT,
    name: 'Delay curto',
    status: 'published',
    published: {
      nodes: [
        { id: 'start', type: 'startNode', data: {} },
        { id: 'antes', type: 'messageNode', data: { text: 'Antes' } },
        { id: 'delay', type: 'delayNode', data: { delay: 1 } },
        { id: 'depois', type: 'messageNode', data: { text: 'Depois' } }
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'antes' },
        { id: 'e2', source: 'antes', target: 'delay' },
        { id: 'e3', source: 'delay', target: 'depois' }
      ]
    }
  });
});

after(() => {
  try { fs.unlinkSync(dbPath); } catch {}
});

test('delay de 1s continua o fluxo sozinho, sem tick do watcher', async () => {
  const from = '5511911110001';
  await handleWhatsAppWebhook({ payload: webhook(from, 'wamid.delay_1'), tenantId: TENANT });

  const chat = await chatDe(from);
  assert.deepEqual(await textosDoBot(chat.id), ['Antes'], 'antes do delay vencer so a primeira mensagem');
  assert.equal(chat.currentNodeId, 'delay');

  await espera(1800);

  assert.deepEqual(await textosDoBot(chat.id), ['Antes', 'Depois']);
  const vivo = await adapter.getDocument('activeChats', { id: chat.id });
  assert.equal(vivo.delayUntil, null);
  assert.equal(vivo.delayNextNodeId, null);

  // O tick que chega depois encontra o delay ja consumido.
  await runChatRuntimeWatcherTick();
  assert.deepEqual(await textosDoBot(chat.id), ['Antes', 'Depois'], 'nao pode continuar duas vezes');
});

test('chat que saiu do bot antes do delay vencer nao continua o fluxo', async () => {
  const from = '5511911110002';
  await handleWhatsAppWebhook({ payload: webhook(from, 'wamid.delay_2'), tenantId: TENANT });

  const chat = await chatDe(from);
  assert.equal(chat.currentNodeId, 'delay');
  await adapter.saveDocument('activeChats', { ...chat, status: 'waiting' });

  await espera(1800);

  assert.deepEqual(await textosDoBot(chat.id), ['Antes']);
});
