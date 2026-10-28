import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

// Usuarios com nivel gravado (user.cargo) passam pelas permissoes do nivel; os
// sem nivel seguem pelo papel, como antes.

const dbPath = path.join(os.tmpdir(), `cargos-rotas-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'cargos-rotas-test-only-secret';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { default: contactsRouter } = await import('../src/routes/contacts.js');
const { default: queuesRouter } = await import('../src/routes/queues.js');
const { default: channelsRouter } = await import('../src/routes/channels.js');
const { default: cannedRouter } = await import('../src/routes/cannedResponses.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

const T = 'tenant_cargos';
let server;
let base;

before(async () => {
  await adapter.init();
  await adapter.insertOne('tenants', { id: T, name: 'Cargos', status: 'active', settings: { maxUsers: 50 } });
  const user = (id, role, cargo) => adapter.insertOne('users', { id, tenantId: T, username: id, name: id, role, ...(cargo ? { cargo } : {}) });
  await user('u_agente_antigo', 'AGENT');
  await user('u_a2', 'AGENT', { nivel: 'A2' });
  await user('u_a2_respostas', 'AGENT', { nivel: 'A2', adicionadas: ['respostas.editar'] });
  await user('u_b5', 'MANAGER', { nivel: 'B5' });
  await user('u_b1', 'MANAGER', { nivel: 'B1' });
  await user('u_c5', 'ADMIN', { nivel: 'C5' });
  await user('u_c6', 'ADMIN', { nivel: 'C6' });
  const app = express();
  app.use(express.json());
  app.use('/contacts', contactsRouter);
  app.use('/queues', queuesRouter);
  app.use('/channels', channelsRouter);
  app.use('/cannedResponses', cannedRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await adapter.close?.();
  fs.rmSync(dbPath, { force: true });
});

const chamar = async (userId, method, url, body) => {
  const token = jwt.sign({ userId }, JWT_SECRET_VALUE, { expiresIn: 60 });
  const res = await fetch(`${base}${url}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.status;
};

const contato = (n) => ({ name: `Cliente ${n}`, phones: [{ channel: 'whatsapp', number: `5511999990${String(n).padStart(3, '0')}` }] });

test('atendente sem nivel gravado segue como hoje (cria contato)', async () => {
  assert.ok([200, 201].includes(await chamar('u_agente_antigo', 'POST', '/contacts', contato(1))));
});

test('A2 atende mas nao edita contatos; caixa a mais libera so o que foi marcado', async () => {
  assert.equal(await chamar('u_a2', 'POST', '/contacts', contato(2)), 403);
  assert.equal(await chamar('u_a2', 'GET', '/contacts'), 200);
  assert.equal(await chamar('u_a2', 'POST', '/cannedResponses', { name: 'Oi', message: 'Oi!' }), 403);
  assert.equal(await chamar('u_a2_respostas', 'POST', '/cannedResponses', { name: 'Oi', message: 'Oi!' }), 201);
});

test('B5 mexe em filas e B1 nao', async () => {
  assert.ok([200, 201].includes(await chamar('u_b5', 'POST', '/queues', { name: 'FILA B5' })));
  assert.equal(await chamar('u_b1', 'POST', '/queues', { name: 'FILA B1' }), 403);
});

test('C5 administra o cliente mas nao mexe na conexao do WhatsApp; C6 mexe', async () => {
  assert.equal(await chamar('u_c5', 'GET', '/channels'), 403);
  assert.equal(await chamar('u_c6', 'GET', '/channels'), 200);
  assert.ok([200, 201].includes(await chamar('u_c5', 'POST', '/queues', { name: 'FILA C5' })));
});
