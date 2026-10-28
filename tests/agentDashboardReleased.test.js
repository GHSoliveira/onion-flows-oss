import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

// Painel do atendente: conversa devolvida ao fluxo perde o agentId, mas
// continua sendo um atendimento dele. Antes sumia do historico e da contagem.

const dbPath = path.join(os.tmpdir(), `agent-dashboard-released-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'agent-dashboard-released-test-only';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { default: chatsRouter } = await import('../src/routes/chats.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

const T = 'tenant_painel';
const agora = Date.now();
const iso = (minAtras) => new Date(agora - minAtras * 60000).toISOString();

const chat = (id, extra) => ({
  id, tenantId: T, channel: 'whatsapp', channelUserId: `55119999${id.slice(-4)}`, queue: 'DEMO', vars: {}, messages: [],
  createdAt: iso(30), updatedAt: iso(5), ...extra
});

before(async () => {
  await adapter.init();
  await adapter.insertOne('users', { id: 'u_bruno', tenantId: T, username: 'bruno', name: 'BRUNO', role: 'AGENT', ratingCount: 1, ratingSum: 5, ratingAvg: 5 });
  await adapter.insertOne('users', { id: 'u_ana', tenantId: T, username: 'ana', name: 'ANA', role: 'AGENT' });
  // Encerrada por ele: continua com agentId.
  await adapter.insertOne('activeChats', chat('chat_0001', { status: 'closed', agentId: 'u_bruno', closedAt: iso(20) }));
  // Devolvida ao fluxo e terminada no no final: sem agentId.
  await adapter.insertOne('activeChats', chat('chat_0002', { status: 'closed', agentId: null, closedAt: iso(10) }));
  // Devolvida e depois assumida pela Ana: nao e "dele agora".
  await adapter.insertOne('activeChats', chat('chat_0003', { status: 'open', agentId: 'u_ana' }));
  // De outra pessoa, nunca foi dele.
  await adapter.insertOne('activeChats', chat('chat_0004', { status: 'closed', agentId: 'u_ana', closedAt: iso(8) }));
  const assumiu = (chatId, id, name, min) => adapter.insertOne('chatEvents', {
    id: `evt_${chatId}_${id}`, tenantId: T, chatId, type: 'AGENT_ASSUMED', timestamp: iso(min), actor: { kind: 'agent', id, name }, context: { queue: 'DEMO' }
  });
  await assumiu('chat_0001', 'u_bruno', 'BRUNO', 25);
  await assumiu('chat_0002', 'u_bruno', 'BRUNO', 15);
  await assumiu('chat_0003', 'u_bruno', 'BRUNO', 14);
  await assumiu('chat_0003', 'u_ana', 'ANA', 12);
  await assumiu('chat_0004', 'u_ana', 'ANA', 9);
  await adapter.insertOne('chatEvents', {
    id: 'evt_nota', tenantId: T, chatId: 'chat_0002', type: 'RATING_SUBMITTED', timestamp: iso(11),
    context: { value: 5, agentId: 'u_bruno', agentName: 'BRUNO', queue: 'DEMO' }
  });
});

after(async () => { await adapter.close?.(); fs.rmSync(dbPath, { force: true }); });

test('painel do atendente inclui conversa devolvida ao fluxo, sem pegar o que esta com outra pessoa', async () => {
  const app = express();
  app.use(express.json());
  app.use('/chats', chatsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  let body;
  try {
    const token = jwt.sign({ userId: 'u_bruno' }, JWT_SECRET_VALUE, { expiresIn: 60 });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/chats/agent-dashboard/me`, { headers: { authorization: `Bearer ${token}` } });
    body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const ids = body.history.map((item) => item.id);
  assert.ok(ids.includes('chat_0001'), 'a que ele encerrou');
  assert.ok(ids.includes('chat_0002'), 'a que ele devolveu ao fluxo');
  assert.ok(ids.includes('chat_0003'), 'ele atendeu antes de passar adiante');
  assert.ok(!ids.includes('chat_0004'), 'nunca foi dele');

  // Pode cair no dia anterior se o teste rodar logo apos a meia-noite; o mes cobre.
  assert.ok(body.month.atendimentos >= 2, `atendimentos do mes: ${body.month.atendimentos}`);
  assert.equal(body.active.open, 0, 'a conversa aberta esta com a Ana, nao com ele');
  assert.equal(body.history.find((item) => item.id === 'chat_0002').rating, 5);
  assert.equal(body.month.ratingAvg, 5);
  assert.equal(body.agent.ratingCount, 1);
});
