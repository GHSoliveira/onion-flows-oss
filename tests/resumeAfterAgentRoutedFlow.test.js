import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

// Atendente devolve a conversa ao fluxo: a volta tem que usar o mesmo fluxo que
// a conversa usava. O tenant da Onion escolhe o fluxo pela rota do numero e nao
// tem fluxo padrao; a volta lia so o padrao, caia no primeiro fluxo publicado
// da lista (sem o no de nota) e a conversa ficava parada em modo robo.

const dbPath = path.join(os.tmpdir(), `resume-routed-flow-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'resume-routed-flow-test-only';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_FAKE_SEND = 'true';
process.env.AI_CLASSIFICATION_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { default: chatsRouter } = await import('../src/routes/chats.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

const T = 'tenant_rota';
const PHONE = 'phone_rota';
const NOTA = 'Dê uma nota para nosso atendimento.';

const fluxo = (id, name, nodes, edges) => ({ id, tenantId: T, name, nodes, edges, published: { nodes, edges } });

before(async () => {
  await adapter.init();
  await adapter.insertOne('tenants', { id: T, name: 'Rota', plan: 'pro', status: 'active' });
  await adapter.insertOne('users', { id: 'u_admin', tenantId: T, username: 'admin_rota', name: 'Admin', role: 'ADMIN', permissions: ['*'] });
  await adapter.insertOne('channelConfigs', {
    id: `channels_${T}`,
    tenantId: T,
    whatsapp: {
      enabled: true,
      accessToken: 'token',
      wabaId: 'waba_rota',
      phoneNumberId: PHONE,
      flowId: null
    },
    // Como em producao: as rotas ficam no documento do canal, fora de "whatsapp".
    entries: [{ id: 'rota_1', platform: 'whatsapp', phoneNumberId: PHONE, flowId: 'f_demo', enabled: true }]
  });
  // Primeiro da lista, publicado, sem o no de nota: era o que a volta usava.
  await adapter.insertOne('flows', fluxo('f_entrada', 'Handler de entrada',
    [{ id: 'start', type: 'startNode', data: {} }, { id: 'msg_1', type: 'messageNode', data: { text: 'oi' } }],
    [{ id: 'e1', source: 'start', target: 'msg_1' }]));
  await adapter.insertOne('flows', fluxo('f_demo', 'Demonstração comercial', [
    { id: 'start', type: 'startNode', data: {} },
    { id: 'fila_1', type: 'queueNode', data: { queueName: 'DEMO', queueMessage: 'Já te passo para alguém.' } },
    { id: 'nota_1', type: 'ratingNode', data: { text: NOTA } },
    { id: 'fim_1', type: 'finalNode', data: { text: 'Obrigado!' } }
  ], [
    { id: 'e1', source: 'start', target: 'fila_1' },
    { id: 'e2', source: 'fila_1', target: 'nota_1' },
    { id: 'e3', source: 'nota_1', target: 'fim_1' }
  ]));
  await adapter.insertOne('activeChats', {
    id: 'chat_rota', tenantId: T, channel: 'whatsapp', channelUserId: '5511999990002', channelChatId: '5511999990002',
    whatsappPhoneNumberId: PHONE, status: 'open', queue: 'DEMO', agentId: 'u_admin', assignedAgentId: 'u_admin',
    continueFlowAfterQueue: true, resumeNodeId: 'nota_1', currentNodeId: null, vars: {}, messages: [],
    createdAt: new Date(Date.now() - 60000).toISOString(), updatedAt: new Date().toISOString()
  });
});

after(async () => {
  await adapter.close?.();
  fs.rmSync(dbPath, { force: true });
});

test('devolver ao fluxo usa o fluxo da rota do numero e chega no no de nota', async () => {
  const app = express();
  app.use(express.json());
  app.use('/chats', chatsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const token = jwt.sign({ userId: 'u_admin' }, JWT_SECRET_VALUE, { expiresIn: 60 });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/chats/chat_rota/close`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ continueFlow: true })
    });
    assert.equal(res.status, 200, await res.text());
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const chat = await adapter.findOne('activeChats', { id: 'chat_rota' });
  assert.equal(chat.status, 'bot');
  assert.equal(chat.currentNodeId, 'nota_1', 'parou no no de nota esperando a resposta, nao em lugar nenhum');

  const mensagens = await adapter.findMany('chatMessages', { query: { chatId: 'chat_rota' } });
  assert.ok(mensagens.some((m) => m.sender === 'bot' && String(m.text).startsWith(NOTA)), 'a pergunta da nota foi enviada');
});
