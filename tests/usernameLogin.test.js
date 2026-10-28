import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

// Mesmo username em dois tenants derrubava o login de um deles: o login pegava
// um usuario qualquer com aquele nome e testava a senha so nele.

const dbPath = path.join(os.tmpdir(), `username-login-${process.pid}.json`);
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'username-login-test-only';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { findUserByLogin, isUsernameTaken } = await import('../src/services/passwords.js');
const { default: usersRouter } = await import('../src/routes/users.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  await adapter.insertOne('tenants', { id: 'tenant_loja', name: 'Loja' });
  // Super admin antigo e um agente criado depois com o mesmo username.
  await adapter.insertOne('users', { id: 'u_super', username: 'admin', role: 'SUPER_ADMIN', tenantId: null, permissions: ['*'], password: await bcrypt.hash('senha-super', 4), createdAt: '2026-08-19T02:09:46.618Z' });
  await adapter.insertOne('users', { id: 'u_agente', username: 'admin', role: 'AGENT', tenantId: 'tenant_loja', password: await bcrypt.hash('senha-agente', 4), createdAt: '2026-09-14T19:38:47.798Z' });
  await adapter.insertOne('users', { id: 'u_maria', username: 'maria', role: 'ADMIN', tenantId: 'tenant_loja', password: await bcrypt.hash('senha-maria', 4), createdAt: '2026-09-01T00:00:00.000Z' });
  await adapter.insertOne('users', { id: 'u_joana', username: 'Joana', role: 'AGENT', tenantId: 'tenant_loja', password: await bcrypt.hash('senha-joana', 4), createdAt: '2026-09-02T00:00:00.000Z' });
});

after(async () => { await adapter.close(); fs.rmSync(dbPath, { force: true }); });

test('login: com username repetido, entra no usuario cuja senha bate', async () => {
  assert.equal((await findUserByLogin('admin', 'senha-super'))?.id, 'u_super');
  assert.equal((await findUserByLogin('admin', 'senha-agente'))?.id, 'u_agente');
  assert.equal(await findUserByLogin('admin', 'errada'), null);
  assert.equal(await findUserByLogin('ninguem', 'senha-super'), null);
});

test('username: unico na plataforma, sem diferenciar maiuscula, ignorando o proprio usuario', async () => {
  assert.equal(await isUsernameTaken('MARIA'), true);
  assert.equal(await isUsernameTaken(' maria '), true);
  assert.equal(await isUsernameTaken('joana'), true, 'gravado como Joana');
  assert.equal(await isUsernameTaken('maria', 'u_maria'), false);
  assert.equal(await isUsernameTaken('joao'), false);
  assert.equal(await isUsernameTaken(''), false);
});

const withServer = async (fn) => {
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/users`;
    const token = jwt.sign({ userId: 'u_super' }, JWT_SECRET_VALUE, { expiresIn: 60 });
    const call = (pathAndQuery, method, body) => fetch(`${base}${pathAndQuery}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    await fn(call);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test('criar usuario: username de outro tenant e recusado', async () => {
  await withServer(async (call) => {
    const antes = (await adapter.findDocuments('users', {})).length;
    const res = await call('?tenantId=tenant_loja', 'POST', { name: 'Outro', username: 'Admin', password: 'senha-nova-123', role: 'AGENT', tenantId: 'tenant_loja' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /ja existe na plataforma/);
    assert.equal((await adapter.findDocuments('users', {})).length, antes, 'nada criado');
  });
});

test('editar usuario: manter o proprio username passa; usar o de outro e recusado', async () => {
  await withServer(async (call) => {
    const mesmo = await call('/u_maria', 'PUT', { name: 'Maria', username: 'maria', role: 'ADMIN' });
    assert.equal(mesmo.status, 200);
    const alheio = await call('/u_maria', 'PUT', { name: 'Maria', username: 'admin', role: 'ADMIN' });
    assert.equal(alheio.status, 400);
    const [maria] = await adapter.findDocuments('users', { id: 'u_maria' });
    assert.equal(maria.username, 'maria');
  });
});
