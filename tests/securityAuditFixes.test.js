import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

const dbPath = path.join(os.tmpdir(), `onion-security-audit-${process.pid}.json`);
process.env.NODE_ENV = 'development';
process.env.DB_ADAPTER = 'json';
process.env.USE_JSON_DB = 'true';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'security-audit-test-secret-not-for-production';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-test-secret';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { default: loadTestRouter, isSandboxSeedEnabled } = await import('../src/routes/loadTest.js');
const { default: chatsRouter } = await import('../src/routes/chats.js');
const { default: usersRouter } = await import('../src/routes/users.js');
const { default: telegramRouter } = await import('../src/routes/telegram.js');
const { resolveAllowedMediaUrl } = await import('../client/src/utils/mediaUrl.js');

let server;
let baseUrl;

const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '5m' });
const request = (route, { method = 'GET', token = null, body = undefined, headers = {} } = {}) => fetch(`${baseUrl}${route}`, {
  method,
  headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...headers
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {})
});

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  await adapter.saveCollection('users', [
    { id: 'agent_a', username: 'agent-a', name: 'Agent A', role: 'AGENT', tenantId: 'tenant_a' },
    { id: 'agent_b', username: 'agent-b', name: 'Agent B', role: 'AGENT', tenantId: 'tenant_a' },
    { id: 'manager_a', username: 'manager-a', name: 'Manager A', role: 'MANAGER', tenantId: 'tenant_a' },
    { id: 'admin_a', username: 'admin-a', name: 'Admin A', role: 'ADMIN', tenantId: 'tenant_a' },
    { id: 'super_scoped', username: 'super-scoped', name: 'Super Scoped', role: 'SUPER_ADMIN', tenantId: 'tenant_a', permissions: ['*'] },
    { id: 'super_root', username: 'super-root', name: 'Super Root', role: 'SUPER_ADMIN', tenantId: null, permissions: ['*'] }
  ]);

  const app = express();
  app.use(express.json());
  app.use('/api/load-test', loadTestRouter);
  app.use('/api/chats', chatsRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/telegram', telegramRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.closeAllConnections?.();
  if (server) await new Promise((resolve) => server.close(resolve));
  await adapter.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

test('seed de carga exige opt-in explicito mesmo em development com JSON DB', () => {
  delete process.env.SANDBOX_SEED_ENDPOINT;
  assert.equal(isSandboxSeedEnabled(), false);
  process.env.SANDBOX_SEED_ENDPOINT = 'true';
  assert.equal(isSandboxSeedEnabled(), true);
});

test('seed-client sem token responde 401', async () => {
  process.env.SANDBOX_SEED_ENDPOINT = 'true';
  const response = await request('/api/load-test/seed-client', {
    method: 'POST',
    body: { nome: 'Sem Token', mensagens: ['teste'] }
  });
  assert.equal(response.status, 401);
});

test('seed-client ignora tenantId do body e usa tenant autenticado', async () => {
  process.env.SANDBOX_SEED_ENDPOINT = 'true';
  const response = await request('/api/load-test/seed-client', {
    method: 'POST',
    token: tokenFor('admin_a'),
    body: { tenantId: 'tenant_b', nome: 'Cliente Seguro', telefone: '5511999999999', mensagens: ['teste'] }
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.tenantId, 'tenant_a');
  assert.equal(await adapter.countDocuments('activeChats', { tenantId: 'tenant_b' }), 0);
  assert.equal(await adapter.countDocuments('activeChats', { tenantId: 'tenant_a', id: payload.chatId }), 1);
});

test('AGENT acessa a propria carteira e nao a de outro agente', async () => {
  const own = await request('/api/chats/agent/agent_a', { token: tokenFor('agent_a') });
  const other = await request('/api/chats/agent/agent_b', { token: tokenFor('agent_a') });
  assert.equal(own.status, 200);
  assert.equal(other.status, 403);
});

test('MANAGER acessa a carteira de outro agente do tenant', async () => {
  const response = await request('/api/chats/agent/agent_b', { token: tokenFor('manager_a') });
  assert.equal(response.status, 200);
});

test('ADMIN nao edita nem remove SUPER_ADMIN do mesmo tenant', async () => {
  const update = await request('/api/users/super_scoped', {
    method: 'PUT',
    token: tokenFor('admin_a'),
    body: { name: 'Super Scoped', username: 'super-scoped', role: 'SUPER_ADMIN' }
  });
  const remove = await request('/api/users/super_scoped', {
    method: 'DELETE',
    token: tokenFor('admin_a')
  });
  assert.equal(update.status, 403);
  assert.equal(remove.status, 403);
  assert.ok(await adapter.findOne('users', { id: 'super_scoped' }));
});

test('SUPER_ADMIN continua autorizado a editar SUPER_ADMIN', async () => {
  const response = await request('/api/users/super_scoped', {
    method: 'PUT',
    token: tokenFor('super_root'),
    body: { name: 'Super Scoped Updated', username: 'super-scoped', role: 'SUPER_ADMIN' }
  });
  assert.equal(response.status, 200);
});

test('webhook Telegram rejeita segredo ausente/incorreto e aceita o correto', async () => {
  const missing = await request('/api/telegram/webhook', { method: 'POST', body: {} });
  const wrong = await request('/api/telegram/webhook', {
    method: 'POST', body: {}, headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }
  });
  const correct = await request('/api/telegram/webhook', {
    method: 'POST', body: {}, headers: { 'X-Telegram-Bot-Api-Secret-Token': process.env.TELEGRAM_WEBHOOK_SECRET }
  });
  assert.equal(missing.status, 403);
  assert.equal(wrong.status, 403);
  assert.equal(correct.status, 200);
});

test('resolver de midia aceita HTTP(S)/uploads e rejeita protocolos ativos', () => {
  const options = { apiBase: 'https://api.example.com/api', backendOrigin: 'https://api.example.com' };
  assert.equal(resolveAllowedMediaUrl('https://cdn.example.com/image.jpg', options), 'https://cdn.example.com/image.jpg');
  assert.equal(resolveAllowedMediaUrl('/uploads/image.jpg', options), 'https://api.example.com/uploads/image.jpg');
  assert.equal(resolveAllowedMediaUrl('data:text/html,unsafe', options), '');
  assert.equal(resolveAllowedMediaUrl('javascript:alert(1)', options), '');
  assert.equal(resolveAllowedMediaUrl('//evil.example/file', options), '');
});
