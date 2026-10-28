import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

const dbPath = path.join(os.tmpdir(), `internal-tasks-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'internal-task-test-key-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
const { default: db } = await import('../db/DatabaseAdapter.js');
const { internalTasks: service, createInternalTaskService } = await import('../src/services/internalTasks.js');
const { default: router } = await import('../src/routes/tasks.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');
const user = (id, role = 'AGENT', tenantId = 'a', queues = ['SUPPORT']) => ({ id, role, tenantId, queues, permissions: ['*'] });
const admin = { tenantId: 'a', user: user('admin-a', 'ADMIN') };
const a = { tenantId: 'a', user: user('agent-a') };
const b = { tenantId: 'a', user: user('agent-b') };
const manager = { tenantId: 'a', user: user('manager-a', 'MANAGER') };
const create = (extra = {}) => service.create(admin, { title: 'Check customer request', queueId: 'q-a', ...extra });
let server;
let base;
before(async () => {
  await db.init();
  for (const record of [admin.user, a.user, b.user, manager.user, user('agent-other', 'AGENT', 'b'), user('super', 'SUPER_ADMIN', null)]) {
    await db.insertOne('users', record);
  }
  for (const id of ['a', 'b']) {
    await db.insertOne('tenants', { id });
    await db.insertOne('queues', { id: `q-${id}`, tenantId: id, name: 'SUPPORT', active: true });
  }
  await db.insertOne('queues', { id: 'q-disabled', tenantId: 'a', name: 'OLD', active: false });
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/tasks`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
  fs.rmSync(dbPath, { force: true });
});

test('create validates destination, payload and role without trusting tenant input', async () => {
  for (const input of [
    { title: 'x' }, { title: '' }, { title: 'x', queueId: 'q-b' },
    { title: 'x', queueId: 'q-disabled' }, { title: 'x', assignedTo: 'agent-other' },
    { title: 'x', assignedTo: 'admin-a' }, { title: 'x', assignedTo: 'agent-a', queueId: 'q-a' },
    { title: 'x', queueId: 'q-a', tenantId: 'b' },
    { title: 'x', queueId: 'q-a', status: 'completed' },
    { title: 'x', queueId: 'q-a', description: 'x'.repeat(12001) }
  ]) await assert.rejects(() => service.create(admin, input), { status: 400 });
  for (const ctx of [a, manager]) await assert.rejects(() => service.create(ctx, { title: 'x', queueId: 'q-a' }), { status: 403 });
  await assert.rejects(() => service.list({ ...a, tenantId: 'b' }), { status: 403 });
  await assert.rejects(() => service.list({ user: user('super', 'SUPER_ADMIN', null) }), { status: 400 });
});

test('agent visibility is own assignments or unclaimed tasks in current tenant queues', async () => {
  const queued = await create();
  const assigned = await service.create(admin, { title: 'Assigned', assignedTo: a.user.id });
  await assert.rejects(() => service.get(b, assigned.id), { status: 404 });
  await assert.rejects(() => service.get({ ...a, user: { ...a.user, queues: [] } }, queued.id), { status: 404 });
  assert.equal((await service.get(a, assigned.id)).id, assigned.id);
  assert.equal((await service.get(manager, assigned.id)).id, assigned.id);
  await assert.rejects(() => service.get({ tenantId: 'b', user: user('other-admin', 'ADMIN', 'b') }, queued.id), { status: 404 });
});

test('list paginates and omits description and unexpected stored fields', async () => {
  const task = await create({ description: 'DETAIL_ONLY' });
  await db.updateOne('internalTasks', { id: task.id }, { $set: { secret: 'NEVER_RETURN' } });
  const result = await service.list(admin, { page: 1, limit: 1 });
  assert.equal(result.items.length, 1);
  assert.ok(result.pagination.total > 1);
  assert.doesNotMatch(JSON.stringify(result), /DETAIL_ONLY|NEVER_RETURN|description/);
  assert.doesNotMatch(JSON.stringify(await service.get(admin, task.id)), /NEVER_RETURN/);
  for (const input of [{ limit: 101 }, { page: 0 }, { status: 'fake' }]) {
    await assert.rejects(() => service.list(admin, input), { status: 400 });
  }
});

test('concurrent queue pickup has exactly one owner and losing agent loses access', async () => {
  const task = await create();
  const results = await Promise.allSettled([a, b].map((ctx) => service.transition(ctx, task.id, { action: 'claim', version: 1 })));
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  const stored = await service.get(admin, task.id);
  assert.equal(stored.version, 2);
  assert.equal(stored.status, 'in_progress');
  const loser = stored.assignedTo === a.user.id ? b : a;
  await assert.rejects(() => service.get(loser, task.id), { status: 404 });
});

test('transitions require ownership, current version and valid state', async () => {
  const task = await create();
  await assert.rejects(() => service.transition(a, task.id, { action: 'complete', version: 1 }), { status: 409 });
  await assert.rejects(() => service.transition(admin, task.id, { action: 'claim', version: 1 }), { status: 403 });
  await assert.rejects(() => service.transition(manager, task.id, { action: 'cancel', version: 1 }), { status: 403 });
  await assert.rejects(() => service.transition(a, task.id, { action: 'cancel', version: 1 }), { status: 403 });
  const claimed = await service.transition(a, task.id, { action: 'claim', version: 1 });
  await assert.rejects(() => service.transition(a, task.id, { action: 'complete', version: 1 }), { status: 409 });
  const completed = await service.transition(a, task.id, { action: 'complete', version: claimed.version });
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);
  await assert.rejects(() => service.transition(admin, task.id, { action: 'cancel', version: completed.version }), { status: 409 });
});

test('database compare-and-set conflict is surfaced instead of falsely confirming success', async () => {
  const task = await create();
  const conflictDb = {
    findMany: (...args) => db.findMany(...args), findOne: (...args) => db.findOne(...args),
    updateOne: async () => ({ matchedCount: 0 })
  };
  const serviceWithConflict = createInternalTaskService(conflictDb);
  await assert.rejects(() => serviceWithConflict.transition(a, task.id, { action: 'claim', version: 1 }), { status: 409 });
  assert.equal((await service.get(admin, task.id)).status, 'pending');
});

test('cancel preserves record and chat/commercial collections are untouched', async () => {
  await db.insertOne('commercialTasks', { id: 'legacy', tenantId: 'a', assignedTo: 'agent-a', status: 'pending' });
  await db.insertOne('activeChats', { id: 'chat', tenantId: 'a', status: 'open', messages: [{ text: 'unchanged' }] });
  const before = await db.getCollection('activeChats');
  const task = await create();
  assert.equal((await service.transition(admin, task.id, { action: 'cancel', version: 1 })).status, 'cancelled');
  assert.deepEqual(await db.getCollection('activeChats'), before);
  assert.equal((await db.findOne('commercialTasks', { id: 'legacy' })).status, 'pending');
});

test('HTTP endpoints authenticate, isolate tenants and retain legacy assigned route', async () => {
  const request = (path, userId, options = {}) => fetch(`${base}${path}`, {
    ...options, headers: { 'Content-Type': 'application/json', ...(userId ? { Authorization: `Bearer ${jwt.sign({ userId }, JWT_SECRET_VALUE, { expiresIn: 60 })}` } : {}) }
  });
  assert.equal((await request('/internal')).status, 401);
  assert.equal((await request('/internal', 'super')).status, 400);
  assert.equal((await request('/internal?tenantId=a', 'super')).status, 200);
  assert.equal((await request('/internal', 'agent-a', { method: 'POST', body: JSON.stringify({ title: 'x', queueId: 'q-a' }) })).status, 403);
  const created = await request('/internal?tenantId=b', 'admin-a', { method: 'POST', body: JSON.stringify({ title: 'HTTP task', queueId: 'q-a' }) });
  assert.equal(created.status, 201);
  const task = await created.json();
  assert.equal(task.tenantId, 'a');
  assert.equal((await request(`/internal/${task.id}`, 'agent-other')).status, 404);
  const legacy = await request('/assigned', 'agent-a');
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).items[0].id, 'legacy');
});
