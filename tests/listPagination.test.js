import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

// Listas com volume: Contatos cortava em 200 e a Auditoria mostrava o id do
// usuario em vez do nome. Com centenas de registros (tenant mock de volume)
// as duas coisas apareceram.

const dbPath = path.join(os.tmpdir(), `list-pagination-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'list-pagination-test-only';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { default: contactsRouter } = await import('../src/routes/contacts.js');
const { listTenantAudit } = await import('../src/services/tenantModules.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

const T = 'tenant_lista';
const TOTAL = 230;

before(async () => {
  await adapter.init();
  await adapter.insertOne('users', { id: 'u_admin', tenantId: T, username: 'admin.lista', name: 'ANA ADMIN', role: 'ADMIN' });
  await adapter.insertOne('users', { id: 'u_root', tenantId: null, username: 'root', name: 'SUPER', role: 'SUPER_ADMIN' });
  for (let i = 0; i < TOTAL; i += 1) {
    const numero = `5500900${String(i).padStart(5, '0')}`;
    await adapter.insertOne('contacts', {
      id: `c_${i}`, tenantId: T, name: i % 10 === 0 ? `Karina ${i}` : `Cliente ${i}`, tags: i % 2 ? ['vip'] : ['novo'],
      phones: [{ id: `p_${i}`, number: numero, normalizedNumber: numero, channel: 'whatsapp', isPrimary: true }],
      updatedAt: new Date(Date.UTC(2026, 8, 1) + i * 60000).toISOString()
    });
  }
  await adapter.insertOne('tenantAuditEvents', { id: 'a1', tenantId: T, type: 'user.updated', actorId: 'u_admin', summary: 'x', timestamp: '2026-09-19T10:00:00.000Z' });
  await adapter.insertOne('tenantAuditEvents', { id: 'a2', tenantId: T, type: 'flow.published', actorId: 'u_root', summary: 'y', timestamp: '2026-09-19T09:00:00.000Z' });
  await adapter.insertOne('tenantAuditEvents', { id: 'a3', tenantId: T, type: 'chat.closed', actorId: 'system', summary: 'z', timestamp: '2026-09-19T08:00:00.000Z' });
});

after(async () => { await adapter.close?.(); fs.rmSync(dbPath, { force: true }); });

const pedir = async (query) => {
  const app = express();
  app.use(express.json());
  app.use('/contacts', contactsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const token = jwt.sign({ userId: 'u_admin' }, JWT_SECRET_VALUE, { expiresIn: 60 });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/contacts?${query}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test('contatos com ?page= trazem pagina, total real e as tags de todos', async () => {
  const { status, body } = await pedir('page=12&limit=20');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.total, TOTAL, 'o total nao para em 200');
  assert.equal(body.pages, 12);
  assert.equal(body.page, 12);
  assert.equal(body.items.length, TOTAL - 11 * 20, 'ultima pagina com o que sobra');
  assert.equal(body.withWhatsApp, TOTAL);
  assert.deepEqual(body.tags, ['novo', 'vip']);
});

test('busca pagina sobre o resultado filtrado e pagina alem do fim cai na ultima', async () => {
  const { body } = await pedir('q=karina&page=9&limit=20');
  assert.equal(body.total, 23);
  assert.equal(body.page, 2);
  assert.equal(body.items.length, 3);
  assert.ok(body.items.every((contact) => contact.name.startsWith('Karina')));
});

test('sem ?page= continua a lista simples de antes', async () => {
  const { body } = await pedir('limit=50');
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 50);
});

test('auditoria mostra o nome de quem fez, inclusive super admin e sistema', async () => {
  const { items } = await listTenantAudit(T, { page: 1, limit: 10 });
  assert.deepEqual(items.map((item) => item.actorName), ['ANA ADMIN', 'SUPER', 'Sistema']);
});
