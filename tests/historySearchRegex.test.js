import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

// A busca "Nome ou texto" do Historico passa uma expressao regular direto no
// filtro ({ customerName: /mariana/i }). O adaptador so entendia { $regex },
// comparava por igualdade e a busca nunca achava nada.

const dbPath = path.join(os.tmpdir(), `history-search-regex-${process.pid}.json`);
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'history-search-regex-test-only';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { default: chatsRouter } = await import('../src/routes/chats.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

const T = 'tenant_clinica';
const conversa = (id, nome, extra = {}) => ({
  id, tenantId: T, status: 'closed', channel: 'whatsapp', channelUserId: `55009001000${id.slice(-2)}`,
  customerName: nome, queue: 'Recepção', createdAt: '2026-09-10T12:00:00.000Z', updatedAt: '2026-09-10T12:30:00.000Z',
  closedAt: '2026-09-10T12:30:00.000Z', messages: [], messageCount: 3, ...extra
});

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  await adapter.insertOne('tenants', { id: T, name: 'Clínica' });
  await adapter.insertOne('users', { id: 'u_super', username: 'super', role: 'SUPER_ADMIN', permissions: ['*'] });
  await adapter.insertOne('activeChats', conversa('chat_01', 'Mariana Costa', { tags: ['retorno', 'vip'] }));
  await adapter.insertOne('activeChats', conversa('chat_02', 'Rafael Almeida'));
  await adapter.insertOne('activeChats', conversa('chat_03', 'Ana Mariana Souza', { status: 'open' }));
  await adapter.insertOne('chatMessages', { id: 'chat_02_m1', tenantId: T, chatId: 'chat_02', sender: 'user', text: 'Meu exame de sangue saiu?', timestamp: '2026-09-10T12:01:00.000Z' });
});

after(async () => { await adapter.close(); fs.rmSync(dbPath, { force: true }); });

test('adaptador: expressao regular direta filtra, conta e funciona dentro de $or', async () => {
  const achados = await adapter.findMany('activeChats', { query: { tenantId: T, customerName: /mariana/i } });
  assert.deepEqual(achados.map((c) => c.id).sort(), ['chat_01', 'chat_03']);

  const comOr = await adapter.findMany('activeChats', { query: { tenantId: T, status: 'closed', $or: [{ id: /nada/ }, { customerName: /MARIANA/i }] } });
  assert.deepEqual(comOr.map((c) => c.id), ['chat_01']);

  assert.equal(await adapter.countDocuments('activeChats', { tenantId: T, $or: [{ customerName: /rafael/i }] }), 1);
  assert.equal(await adapter.countDocuments('activeChats', { tenantId: T, customerName: /inexistente/i }), 0);
});

test('adaptador: em campo lista, basta um item casar; regex com flag g nao muda de resultado entre chamadas', async () => {
  // Ancorada: so casa comparando item a item, nao a lista virada texto.
  const porTag = await adapter.findMany('activeChats', { query: { tenantId: T, tags: /^vip$/ } });
  assert.deepEqual(porTag.map((c) => c.id), ['chat_01']);

  const global = /mariana/gi;
  const primeira = await adapter.countDocuments('activeChats', { tenantId: T, customerName: global });
  const segunda = await adapter.countDocuments('activeChats', { tenantId: T, customerName: global });
  assert.equal(primeira, 2);
  assert.equal(segunda, 2, 'lastIndex da flag g nao pode vazar entre testes');
});

const buscar = async (q) => {
  const app = express();
  app.use(express.json());
  app.use('/chats', chatsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const token = jwt.sign({ userId: 'u_super' }, JWT_SECRET_VALUE, { expiresIn: 60 });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/chats/history?tenantId=${T}&q=${encodeURIComponent(q)}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test('historico: busca pelo nome do cliente encontra a conversa encerrada', async () => {
  const { status, body } = await buscar('Mariana');
  assert.equal(status, 200);
  assert.deepEqual(body.items.map((c) => c.id), ['chat_01'], 'so conversas encerradas entram no historico');
});

test('historico: busca pelo texto de uma mensagem encontra a conversa', async () => {
  const { body } = await buscar('exame de sangue');
  assert.deepEqual(body.items.map((c) => c.id), ['chat_02']);
});

test('historico: termo que nao existe devolve vazio e caractere especial nao quebra', async () => {
  assert.equal((await buscar('ninguem com esse nome')).body.items.length, 0);
  const especial = await buscar('Mariana (retorno) [vip]*');
  assert.equal(especial.status, 200);
});
