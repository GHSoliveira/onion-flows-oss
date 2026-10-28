import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// O watcher nao rele cada conversa a cada tick (eram 2 leituras por conversa em
// bot, disputando o banco com o atendimento num pico) e, como passa a decidir
// pela lista do tick, revalida dentro do lock antes de agir.

const dbPath = path.join(os.tmpdir(), `onion-watcher-leitura-${process.pid}.json`);

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'watcher-leitura-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_FAKE_SEND = 'true';
process.env.AI_CLASSIFICATION_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { runChatRuntimeWatcherTick } = await import('../src/services/chatRuntimeWatcher.js');
const { getChatMessages } = await import('../src/services/chatMessages.js');

const TENANT = 'tenant_leitura';
const minutos = (n) => new Date(Date.now() + n * 60 * 1000).toISOString();

const chat = (id, extra = {}) => ({
  id,
  tenantId: TENANT,
  channel: 'whatsapp',
  channelUserId: `55119888${id.slice(-4)}`,
  channelChatId: `55119888${id.slice(-4)}`,
  whatsappPhoneNumberId: 'sender_leitura',
  status: 'bot',
  vars: {},
  messages: [],
  currentNodeId: null,
  createdAt: minutos(-5),
  updatedAt: minutos(-5),
  ...extra
});

const textosDoBot = async (chatId) => (await getChatMessages(chatId)).filter((m) => m.sender === 'bot').map((m) => m.text);

// Roda um tick com a lista de conversas trocada por `lista` (simula lista atrasada)
// e conta quantas vezes o watcher releu uma conversa pelo id.
const tickCom = async (lista) => {
  const originalFind = adapter.findDocuments.bind(adapter);
  const originalGet = adapter.getDocument.bind(adapter);
  let releituras = 0;
  if (lista) adapter.findDocuments = async (name, filter, options) => (name === 'activeChats' ? lista : originalFind(name, filter, options));
  adapter.getDocument = async (name, filter) => {
    if (name === 'activeChats' && filter?.id) releituras += 1;
    return originalGet(name, filter);
  };
  try {
    await runChatRuntimeWatcherTick();
  } finally {
    adapter.findDocuments = originalFind;
    adapter.getDocument = originalGet;
  }
  return releituras;
};

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  await adapter.insertOne('tenants', { id: TENANT, name: 'Tenant Leitura', status: 'active' });
  await adapter.insertOne('channelConfigs', {
    id: `channels_${TENANT}`,
    tenantId: TENANT,
    whatsapp: { enabled: true, accessToken: 'test-access-token', phoneNumberId: 'sender_leitura' }
  });
  await adapter.insertOne('tenantSettings', {
    id: `settings_${TENANT}`,
    tenantId: TENANT,
    inactivityMaxHours: 8,
    inactivityMessage: 'Atendimento encerrado por inatividade.'
  });
  await adapter.insertOne('flows', {
    id: 'flow_menu_timeout',
    tenantId: TENANT,
    name: 'Menu com prazo',
    status: 'published',
    published: {
      nodes: [
        { id: 'start', type: 'startNode', data: {} },
        { id: 'menu', type: 'menuNode', data: { text: 'Escolha', options: [{ id: '1', label: 'A' }], timeoutMinutes: 5, timeoutMessage: 'Prazo do menu vencido' } },
        { id: 'fim', type: 'messageNode', data: { text: 'Fim' } }
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'menu' },
        { id: 'e2', source: 'menu', target: 'fim', sourceHandle: 'else' }
      ]
    }
  });
});

after(() => {
  try { fs.unlinkSync(dbPath); } catch {}
});

test('tick sem nada vencido nao rele nenhuma conversa', async () => {
  for (let i = 0; i < 30; i += 1) {
    await adapter.insertOne('activeChats', chat(`chat_ocioso_${String(i).padStart(4, '0')}`));
  }
  const releituras = await tickCom(null);
  assert.equal(releituras, 0);
});

test('lista atrasada nao encerra por inatividade quem acabou de mandar mensagem', async () => {
  const id = 'chat_ativo_0001';
  await adapter.insertOne('activeChats', chat(id, { createdAt: minutos(-600), updatedAt: minutos(-1) }));
  const atrasada = chat(id, { createdAt: minutos(-600), updatedAt: minutos(-540) });
  await tickCom([atrasada]);
  const vivo = await adapter.getDocument('activeChats', { id });
  assert.equal(vivo.status, 'bot');
  assert.deepEqual(await textosDoBot(id), []);
});

test('lista atrasada nao dispara prazo de no que o cliente ja respondeu', async () => {
  const id = 'chat_respondeu_0001';
  await adapter.insertOne('activeChats', chat(id, { flowId: 'flow_menu_timeout', currentNodeId: null, updatedAt: minutos(-1) }));
  const atrasada = chat(id, { flowId: 'flow_menu_timeout', currentNodeId: 'menu', currentNodeEnteredAt: minutos(-10), updatedAt: minutos(-10) });
  await tickCom([atrasada]);
  assert.deepEqual(await textosDoBot(id), []);
});

test('prazo realmente vencido continua sendo tratado', async () => {
  const id = 'chat_vencido_0001';
  await adapter.insertOne('activeChats', chat(id, { flowId: 'flow_menu_timeout', currentNodeId: 'menu', currentNodeEnteredAt: minutos(-10), updatedAt: minutos(-10) }));
  await tickCom(null);
  assert.ok((await textosDoBot(id)).includes('Prazo do menu vencido'));
  const vivo = await adapter.getDocument('activeChats', { id });
  assert.notEqual(vivo.currentNodeId, 'menu');
});
