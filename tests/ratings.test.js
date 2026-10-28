import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Nota do cliente: vale no momento em que ele responde o no de nota, para o
// atendente que atendeu. Antes, no fluxo fila -> atendente -> nota -> fim, a
// nota ficava so em vars.nota e nao chegava ao atendente nem ao relatorio.

const dbPath = path.join(os.tmpdir(), `ratings-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'ratings-test-only';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_FAKE_SEND = 'true';
process.env.AI_CLASSIFICATION_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { applyUserInput } = await import('../src/services/flowRunner.js');
const { emitChatEvent } = await import('../src/services/chatEvents.js');
const { buildMonthlyPeriod } = await import('../src/services/monthlyAnalyticsModel.js');

const T = 'tenant_nota';

const fluxo = (variableName) => ({
  nodes: [
    { id: 'nota_1', type: 'ratingNode', data: { text: 'Dê uma nota de 1 a 5', ...(variableName ? { variableName } : {}) } },
    { id: 'fim_1', type: 'finalNode', data: { text: 'Obrigado!' } }
  ],
  edges: [{ id: 'e1', source: 'nota_1', target: 'fim_1' }]
});

// Conversa como fica depois de o atendente devolver ao fluxo: sem atendente,
// parada no no de nota.
const conversa = async (id, extra = {}) => {
  const chat = {
    id, tenantId: T, channel: 'whatsapp', channelUserId: '5511999990003', status: 'bot', queue: 'DEMO',
    agentId: null, currentNodeId: 'nota_1', vars: {}, messages: [],
    createdAt: new Date(Date.now() - 120000).toISOString(), updatedAt: new Date().toISOString(), ...extra
  };
  await adapter.insertOne('activeChats', chat);
  return chat;
};

const evento = (chatId, type, extra = {}) => emitChatEvent({ tenantId: T, chatId, type, ...extra });

const responder = async (chatId, texto, flow = fluxo()) => {
  const chat = await adapter.findOne('activeChats', { id: chatId });
  return applyUserInput({ chat, flowData: flow, text: texto, templates: [], schedules: [], sendMessage: async () => ({}) });
};

const notas = (chatId) => adapter.findMany('chatEvents', { query: { tenantId: T, chatId, type: 'RATING_SUBMITTED' } });
const atendente = (id) => adapter.findOne('users', { id });

before(async () => { await adapter.init(); });

beforeEach(async () => {
  for (const collection of ['activeChats', 'chatEvents', 'chatMessages', 'users']) await adapter.deleteMany(collection, {});
  await adapter.insertOne('users', { id: 'u_ana', tenantId: T, username: 'ana', name: 'ANA', role: 'AGENT' });
  await adapter.insertOne('users', { id: 'u_antigo', tenantId: T, username: 'antigo', name: 'ANTIGO', role: 'AGENT' });
});

after(async () => { await adapter.close?.(); fs.rmSync(dbPath, { force: true }); });

test('nota depois de o atendente devolver ao fluxo vai para esse atendente, uma vez so', async () => {
  await conversa('chat_a');
  await evento('chat_a', 'FLOW_STARTED');
  await evento('chat_a', 'AGENT_ASSUMED', { actor: { kind: 'agent', id: 'u_ana', name: 'ANA' }, context: { queue: 'DEMO' } });
  await evento('chat_a', 'RESUME_TO_FLOW', { context: { agentId: 'u_ana', resumeNodeId: 'nota_1' } });

  await responder('chat_a', '5');

  const [nota] = await notas('chat_a');
  assert.equal(nota.context.value, 5);
  assert.equal(nota.context.agentId, 'u_ana');
  assert.equal(nota.context.agentName, 'ANA');
  assert.equal(nota.context.queue, 'DEMO');

  const g = await atendente('u_ana');
  assert.equal(g.ratingCount, 1, 'o no final nao soma de novo');
  assert.equal(g.ratingAvg, 5);
  assert.equal((await adapter.findOne('activeChats', { id: 'chat_a' })).status, 'closed', 'seguiu ate o fim');
});

test('segunda nota do mesmo atendente atualiza a media certa', async () => {
  for (const [id, valor] of [['chat_b1', '5'], ['chat_b2', '2']]) {
    await conversa(id);
    await evento(id, 'FLOW_STARTED');
    await evento(id, 'AGENT_ASSUMED', { actor: { kind: 'agent', id: 'u_ana', name: 'ANA' } });
    await responder(id, valor);
  }
  const g = await atendente('u_ana');
  assert.equal(g.ratingCount, 2);
  assert.equal(g.ratingSum, 7);
  assert.equal(g.ratingAvg, 3.5);
});

test('variavel com nome personalizado tambem conta', async () => {
  await conversa('chat_c');
  await evento('chat_c', 'FLOW_STARTED');
  await evento('chat_c', 'AGENT_ASSUMED', { actor: { kind: 'agent', id: 'u_ana', name: 'ANA' } });
  await responder('chat_c', '4', fluxo('nota_atendimento'));
  const [nota] = await notas('chat_c');
  assert.equal(nota.context.value, 4);
  assert.equal(nota.context.variableName, 'nota_atendimento');
  assert.equal((await atendente('u_ana')).ratingCount, 1);
});

test('atendente de uma rodada anterior do fluxo nao recebe a nota', async () => {
  await conversa('chat_d');
  await evento('chat_d', 'FLOW_STARTED');
  await evento('chat_d', 'AGENT_ASSUMED', { actor: { kind: 'agent', id: 'u_antigo', name: 'ANTIGO' } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await evento('chat_d', 'FLOW_STARTED');
  await responder('chat_d', '3');
  const [nota] = await notas('chat_d');
  assert.equal(nota.context.agentId, null, 'so fluxo nesta rodada: nota sem atendente');
  assert.equal((await atendente('u_antigo')).ratingCount ?? 0, 0);
});

test('nota invalida pede de novo e nao registra nada', async () => {
  await conversa('chat_e');
  const resultado = await responder('chat_e', '9');
  assert.equal(resultado.reason, 'rating_validation_error');
  assert.equal((await notas('chat_e')).length, 0);
});

test('simulador do editor nao entra em media nem relatorio', async () => {
  await conversa('chat_f', { isFlowTest: true, agentId: 'u_ana' });
  await responder('chat_f', '5');
  assert.equal((await notas('chat_f')).length, 0);
  assert.equal((await atendente('u_ana')).ratingCount ?? 0, 0);
});

test('relatorio mensal: nota de conversa que terminou no no final conta para atendente e fila', () => {
  const start = Date.UTC(2026, 8, 1, 3);
  const end = Date.UTC(2026, 9, 1, 3);
  const ts = (min) => new Date(Date.UTC(2026, 8, 18, 15, min)).toISOString();
  const chats = [
    // Terminou no no final do fluxo: nao ha evento de encerramento.
    { id: 'novo', tenantId: T, createdAt: ts(0), closedAt: ts(10), status: 'closed', channel: 'whatsapp', channelUserId: '1', queue: 'DEMO', agentId: null, vars: { nota: 5 } },
    // Nota antiga, sem evento: continua pela variavel e pelo encerramento do agente.
    { id: 'antigo', tenantId: T, createdAt: ts(0), closedAt: ts(20), status: 'closed', channel: 'whatsapp', channelUserId: '2', queue: 'DEMO', agentId: 'u_antigo', agentName: 'ANTIGO', vars: { nota: 3 } }
  ];
  const events = [
    { id: 'e1', chatId: 'novo', type: 'FLOW_STARTED', timestamp: ts(0) },
    { id: 'e2', chatId: 'novo', type: 'AGENT_ASSUMED', timestamp: ts(2), actor: { id: 'u_ana', name: 'ANA' } },
    { id: 'e3', chatId: 'novo', type: 'RATING_SUBMITTED', timestamp: ts(9), context: { value: 5, agentId: 'u_ana', agentName: 'ANA', queue: 'DEMO' } },
    { id: 'e4', chatId: 'antigo', type: 'AGENT_ASSUMED', timestamp: ts(5), actor: { id: 'u_antigo', name: 'ANTIGO' } },
    { id: 'e5', chatId: 'antigo', type: 'AGENT_CLOSED', timestamp: ts(20) }
  ];
  const periodo = buildMonthlyPeriod(chats, events, start, end);
  assert.equal(periodo.summary.ratingSamples, 2, 'a nova pelo evento e a antiga pela variavel, sem repetir a nova');
  assert.equal(periodo.summary.rating, 4);
  const ana = periodo.agents.find((a) => a.id === 'u_ana');
  assert.equal(ana.rating, 5);
  assert.equal(ana.ratingSamples, 1);
  assert.equal(periodo.agents.find((a) => a.id === 'u_antigo').rating, 3);
  assert.equal(periodo.queues.find((q) => q.id === 'DEMO').ratingSamples, 2);
});
