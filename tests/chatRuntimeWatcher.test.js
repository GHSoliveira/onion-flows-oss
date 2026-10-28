import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Watcher de runtime: retoma delay vencido e so carrega chats com o bot rodando.
// A consulta antiga (`status: { $ne: 'closed' }`) nao virava SQL no Postgres e
// baixava a colecao inteira de chats a cada tick.

const dbPath = path.join(os.tmpdir(), `onion-runtime-watcher-${process.pid}.json`);

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'runtime-watcher-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_FAKE_SEND = 'true';
process.env.AI_CLASSIFICATION_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { default: PostgresAdapter } = await import('../db/PostgresAdapter.js');
const { runChatRuntimeWatcherTick } = await import('../src/services/chatRuntimeWatcher.js');
const { getChatMessages } = await import('../src/services/chatMessages.js');

const TENANT = 'tenant_watcher';
const minutos = (n) => new Date(Date.now() + n * 60 * 1000).toISOString();

const chat = (id, extra = {}) => ({
  id,
  tenantId: TENANT,
  channel: 'whatsapp',
  channelUserId: `55119999${id.slice(-4)}`,
  channelChatId: `55119999${id.slice(-4)}`,
  whatsappPhoneNumberId: 'sender_watcher',
  status: 'bot',
  vars: {},
  messages: [],
  currentNodeId: 'delay',
  currentNodeEnteredAt: minutos(-2),
  delayNodeId: 'delay',
  delayNextNodeId: 'depois',
  delayUntil: minutos(-1),
  createdAt: minutos(-2),
  updatedAt: minutos(-2),
  ...extra
});

const textosDoBot = async (chatId) => (await getChatMessages(chatId))
  .filter((m) => m.sender === 'bot')
  .map((m) => m.text);

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();

  await adapter.insertOne('tenants', { id: TENANT, name: 'Tenant Watcher', status: 'active' });
  await adapter.insertOne('channelConfigs', {
    id: `channels_${TENANT}`,
    tenantId: TENANT,
    whatsapp: { enabled: true, accessToken: 'test-access-token', phoneNumberId: 'sender_watcher' }
  });
  await adapter.insertOne('flows', {
    id: 'flow_delay',
    tenantId: TENANT,
    name: 'Delay',
    status: 'published',
    published: {
      nodes: [
        { id: 'start', type: 'startNode', data: {} },
        { id: 'delay', type: 'delayNode', data: { delay: 5 } },
        { id: 'depois', type: 'messageNode', data: { text: 'Depois do delay' } }
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'delay' },
        { id: 'e2', source: 'delay', target: 'depois' }
      ]
    }
  });

  await adapter.insertOne('activeChats', chat('chat_vencido_0001'));
  await adapter.insertOne('activeChats', chat('chat_futuro_0002', { delayUntil: minutos(10) }));
  // Estado velho de delay em chat que ja foi para a fila: o watcher nao pode tocar.
  await adapter.insertOne('activeChats', chat('chat_fila_0003', { status: 'waiting' }));
  await adapter.insertOne('activeChats', chat('chat_editor_0004', { isFlowTest: true }));
  await adapter.insertOne('activeChats', chat('chat_fechado_0005', { status: 'closed' }));
  // Inatividade de 8 h: conversa comum parada 9 h fecha; conversa de campanha nao.
  await adapter.insertOne('tenantSettings', {
    id: `settings_${TENANT}`,
    tenantId: TENANT,
    inactivityMaxHours: 8,
    inactivityMessage: 'Atendimento encerrado por inatividade.'
  });
  const parado = { currentNodeId: null, delayNodeId: null, delayNextNodeId: null, delayUntil: null, createdAt: minutos(-540), updatedAt: minutos(-540) };
  await adapter.insertOne('activeChats', chat('chat_parado_0006', parado));
  await adapter.insertOne('activeChats', chat('chat_campanha_0007', { ...parado, activeOutreach: true }));
  // Lead que pediu para sair: activeOutreach caiu, mas a conversa veio de campanha.
  await adapter.insertOne('activeChats', chat('chat_saiu_0008', { ...parado, activeOutreach: false, outreachLastSentAt: minutos(-600) }));
  // Veio de campanha mas hoje esta no meio do fluxo: fecha como qualquer conversa.
  await adapter.insertOne('activeChats', chat('chat_fluxo_0009', { ...parado, currentNodeId: 'depois', outreachLastSentAt: minutos(-2000) }));

  const filtros = [];
  const original = adapter.findDocuments.bind(adapter);
  adapter.findDocuments = async (name, filter, options) => {
    if (name === 'activeChats') filtros.push(filter);
    return original(name, filter, options);
  };
  await runChatRuntimeWatcherTick();
  adapter.findDocuments = original;
  globalThis.__filtrosDoWatcher = filtros;
});

after(() => {
  try { fs.unlinkSync(dbPath); } catch {}
});

test('a consulta do watcher vira clausula SQL de status no Postgres', () => {
  const [filtro] = globalThis.__filtrosDoWatcher;
  assert.ok(filtro, 'o tick precisa consultar activeChats');

  const { text, values } = PostgresAdapter.prototype.buildCandidateQuery.call(
    { tableName: 'app_documents' },
    'activeChats',
    filtro
  );
  assert.match(text, /doc @>/, `sem clausula de documento: ${text}`);
  assert.ok(values.includes(JSON.stringify({ status: 'bot' })), 'status bot precisa ir para o SQL');
});

test('delay vencido retoma o fluxo e limpa o estado de delay', async () => {
  assert.deepEqual(await textosDoBot('chat_vencido_0001'), ['Depois do delay']);

  const vivo = await adapter.getDocument('activeChats', { id: 'chat_vencido_0001' });
  assert.equal(vivo.delayUntil, null);
  assert.equal(vivo.delayNextNodeId, null);
  assert.notEqual(vivo.currentNodeId, 'delay');
});

test('delay que ainda nao venceu continua esperando', async () => {
  assert.deepEqual(await textosDoBot('chat_futuro_0002'), []);
  const vivo = await adapter.getDocument('activeChats', { id: 'chat_futuro_0002' });
  assert.equal(vivo.currentNodeId, 'delay');
  assert.ok(vivo.delayUntil);
});

test('chat na fila, de teste do editor ou fechado nao e tocado', async () => {
  for (const id of ['chat_fila_0003', 'chat_editor_0004', 'chat_fechado_0005']) {
    assert.deepEqual(await textosDoBot(id), [], `${id} nao podia receber mensagem`);
    const vivo = await adapter.getDocument('activeChats', { id });
    assert.equal(vivo.delayNextNodeId, 'depois', `${id} nao podia ter o delay consumido`);
  }
});

test('inatividade fecha conversa comum, mas nunca conversa de campanha', async () => {
  const comum = await adapter.getDocument('activeChats', { id: 'chat_parado_0006' });
  assert.equal(comum.status, 'closed');
  assert.deepEqual(await textosDoBot('chat_parado_0006'), ['Atendimento encerrado por inatividade.']);

  const campanha = await adapter.getDocument('activeChats', { id: 'chat_campanha_0007' });
  assert.equal(campanha.status, 'bot');
  assert.deepEqual(await textosDoBot('chat_campanha_0007'), [], 'lead da campanha nao pode receber o encerramento');
});

test('quem recebeu campanha e saiu dela nao recebe encerramento; no meio do fluxo, recebe', async () => {
  const saiu = await adapter.getDocument('activeChats', { id: 'chat_saiu_0008' });
  assert.equal(saiu.status, 'bot');
  assert.deepEqual(await textosDoBot('chat_saiu_0008'), [], 'quem pediu para sair nao pode receber o encerramento');

  const fluxo = await adapter.getDocument('activeChats', { id: 'chat_fluxo_0009' });
  assert.equal(fluxo.status, 'closed');
});
